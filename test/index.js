const os                                                       = require('os')
const https                                                    = require('https')
const util                                                     = require('util')
const AutoEncrypt                                              = require('..')
const Configuration                                            = require('../lib/Configuration')
const Certificate                                              = require('../lib/Certificate')
const LetsEncryptServer                                        = require('../lib/LetsEncryptServer')
const ocsp                                                     = require('ocsp')
const bent                                                     = require('bent')
const test                                                     = require('tape')
const Pebble                                                   = require('@small-tech/node-pebble')
const { createTestSettingsPath, dehydrate, throwsErrorOfType } = require('../lib/test-helpers')

const httpsGetString = bent('GET', 'string')

test('Auto Encrypt', async t => {
  // Run the tests using either a local Pebble server (default) or the Let’s Encrypt Staging server
  // (which is subject to rate limits) if the STAGING environment variable is set.
  // Use npm test task for the former and npm run test-staging task for the latter.
  const isStaging = process.env.STAGING
  const isPebble = !isStaging
  const letsEncryptServerType = isStaging ? AutoEncrypt.serverType.STAGING : AutoEncrypt.serverType.PEBBLE

  if (isPebble) {
    //
    // If we’re testing with Pebble, fire up a local Pebble server and shut it down when all tests are done.
    //
    // Note: due to the way Node Pebble and tape are designed, we can get away with only including a call to
    // ===== Pebble.ready() here instead of in every test file (doing so is also legitimate and would work too) as:
    //
    //         - tape will always run this index test first.
    //         - test.onFinish() is only fired when all tests (not just the ones in this file) are finished running.
    //
    await Pebble.ready()

    test.onFinish(async () => {
      if (letsEncryptServerType === AutoEncrypt.serverType.PEBBLE) {
        // If we’re testing with Pebble, shut down the Pebble server.
        await Pebble.shutdown()
      }
    })
  }

  // Test that AutoEncrypt.https is an alias for AutoEncrypt (syntactic sugar).
  t.strictEquals(AutoEncrypt.https, AutoEncrypt, 'AutoEncrypt.https is an alias for AutoEncrypt')

  // Attempt to instantiate static AutoEncrypt class should throw.
  t.ok(throwsErrorOfType(
    () => { new AutoEncrypt() },
    Symbol.for('StaticClassCannotBeInstantiatedError')
  ), 'attempt to instantiate AutoEncrypt static class throws as expected')

  const testSettingsPath = createTestSettingsPath()

  const hostname = os.hostname()
  let options = {
    domains: [hostname],
    serverType: letsEncryptServerType,
    settingsPath: testSettingsPath
  }
  const server = AutoEncrypt.https.createServer(options, (request, response) => {
    response.end('ok')
  })

  t.ok(server instanceof https.Server, 'https.Server instance returned as expected')

  // Test inspection string.
  const expectedInspectionString = dehydrate(`
  # AutoEncrypt (static class)
    - Using Let’s Encrypt ${isPebble ? 'pebble' : 'staging'} server.
    - Managing TLS for ${isPebble ? 'localhost, pebble (default domains)' : `${hostname}`}.
    - Settings stored at /home/aral/.small-tech.org/auto-encrypt/test.
    - Listener is set.
  `)
  t.strictEquals(dehydrate(util.inspect(AutoEncrypt)), expectedInspectionString, 'inspection string is as expected')

  await new Promise ((resolve, reject) => {
    server.listen(443, () => {
      resolve()
    })
  })

  const urlToHit = `https://${ process.env.STAGING ? hostname : 'localhost' }`

  let response = httpsGetString(urlToHit)

  // Test server is busy response while attempting to provision the initial certificate.
  let responseWhenServerShouldBeBusy
  try {
    responseWhenServerShouldBeBusy = await httpsGetString(urlToHit)
    t.fail('call to server should not succeed when server is busy provisioning initial certificate')
  } catch (error) {
    t.strictEquals(error.code, 'ECONNRESET', 'correct error returned during connection attempt when server is busy provisioning initial certificate')
  }

  response = await response

  t.strictEquals(response, 'ok', 'response is as expected')

  //
  // Test SNICallback.
  //
  const symbols = Object.getOwnPropertySymbols(server)
  sniCallbackSymbol = symbols.filter(symbol => symbol.toString() === 'Symbol(snicallback)')[0]

  await new Promise ((resolve, reject) => {
    const sniCallback = server[sniCallbackSymbol]

    sniCallback('localhost', (error, secureContext) => {
      if (error) {
        t.fail('SNI Callback should not error, but it did: ${error}')
        return
      }
      t.pass('SNI Callback returned secure context')
      resolve()
    })
  })

  server.close()
  AutoEncrypt.shutdown()

  // Create a second server. This time, it should get the certificate from disk.
  // Note: recreating options object as original one was passed by reference and
  // ===== no longer contains the initial settings.
  options = {
    domains: [hostname],
    serverType: letsEncryptServerType,
    settingsPath: testSettingsPath
  }
  const server2 = AutoEncrypt.https.createServer(options, (request, response) => {
    response.end('ok')
  })

  t.ok(server2 instanceof https.Server, 'second https.Server instance returned as expected')

  await new Promise ((resolve, reject) => {
    server2.listen(443, () => {
      resolve()
    })
  })

  const response2 = await httpsGetString(urlToHit)
  t.strictEquals(response, 'ok', 'second response is as expected')

  server2.close()
  AutoEncrypt.shutdown()

  //
  // Test OCSPStapling. (We can only test this fully using the Pebble server.)
  //

  if (isPebble) {
    const configuration = new Configuration({
      settingsPath: testSettingsPath,
      domains: ['localhost', 'pebble'],
      server: new LetsEncryptServer(AutoEncrypt.serverType.PEBBLE)
    })

    const certificate = new Certificate(configuration)
    certificate.stopCheckingForRenewal()
    const certificatePem = certificate.pem
    const certificateDetails = certificate.parseDetails(certificatePem)

    const certificateDer = ocsp.utils.toDER(certificatePem)
    const issuerDer = ocsp.utils.toDER(await httpsGetString('https://localhost:15000/intermediates/0'))

    // Start a mock OCSP server at the port specified in the Pebble configuration file.
    let mockOcspServer
    await new Promise(async (resolve, reject) => {
      const ocspServerCert = await httpsGetString('https://localhost:15000/intermediates/0')
      const ocspServerKey  = await httpsGetString('https://localhost:15000/intermediate-keys/0')

      // Create the mock OCSP server.
      mockOcspServer = ocsp.Server.create({
        cert: ocspServerCert, // Pebble Root CA cert.
        key : ocspServerKey   // Pebble Root CA private key.
      })

      // Add the cert.
      mockOcspServer.addCert(certificateDetails.serialNumber, 'good')

      mockOcspServer.listen(8888, () => {
        resolve()
      })
    })

    let mockHttpsServer
    await new Promise(async (resolve, reject) => {
      mockHttpsServer = {
        on: (eventName, eventCallback) => {
          t.strictEquals(eventName, 'OCSPRequest', 'OSCPRequest event listener is added as expected')

          eventCallback(certificateDer, issuerDer, (error, response) => {
            if (error) {
              t.fail(`OCSPRequest event handler should not error but it did. ${error}`)
              reject()
            }
            t.pass(`OSCPRequest event handler returned non-error response.`)
            resolve()
          })
        }
      }
      AutoEncrypt.addOcspStapling(mockHttpsServer)
    })

    AutoEncrypt.clearOcspCacheTimers()
    mockOcspServer.close()

    // Wait until the server is closed before returning.
    await new Promise((resolve, reject) => {
      mockOcspServer.on('close', () => {
        resolve()
      })
      mockOcspServer.on('error', (error) => {
        reject(error)
      })
    })
  }

  t.end()
})
