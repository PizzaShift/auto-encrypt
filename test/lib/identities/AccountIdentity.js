const os                                   = require('os')
const path                                 = require('path')
const util                                 = require('util')
const fs                                   = require('fs-extra')
const jose                                 = require('jose')
const test                                 = require('tape')
const AccountIdentity                      = require('../../../lib/identities/AccountIdentity')
const Configuration                        = require('../../../lib/Configuration')
const LetsEncryptServer                    = require('../../../lib/LetsEncryptServer')
const { symbolOfErrorThrownBy, dehydrate } = require('../../../lib/test-helpers')

function setup() {
  // Run the tests using either a local Pebble server (default) or the Let’s Encrypt Staging server
  // (which is subject to rate limits) if the STAGING environment variable is set.
  // Use npm test task for the former and npm run test-staging task for the latter.
  const letsEncryptServerType = process.env.STAGING ? LetsEncryptServer.type.STAGING : LetsEncryptServer.type.PEBBLE

  const domains = {
    [LetsEncryptServer.type.PEBBLE]: ['localhost', 'pebble'],
    [LetsEncryptServer.type.STAGING]: [os.hostname(), `www.${os.hostname()}`]
  }

  const customSettingsPath = path.join(os.homedir(), '.small-tech.org', 'auto-encrypt', 'test')
  fs.removeSync(customSettingsPath)
  return new Configuration({
    domains: domains[letsEncryptServerType],
    server: new LetsEncryptServer(letsEncryptServerType),
    settingsPath: customSettingsPath
  })
}

test('Account Identity', t => {

  const configuration = setup()

  //
  // Initialisation (error conditions)
  //

  // Missing configuration argument should throw.
  t.strictEquals(
    symbolOfErrorThrownBy(() => new AccountIdentity()),
    Symbol.for('UndefinedOrNullError'),
    'throws when configuration argument is missing'
  )

  const accountId = new AccountIdentity(configuration)

  t.strictEquals(accountId.filePath, configuration.accountIdentityPath, 'correct file path is set')

  t.ok(jose.JWK.isKey(accountId.key), 'the key is a jose.JWK RSAKey as expected')
  t.strictEquals(accountId.privatePEM, accountId.key.toPEM(/* private = */ true), 'private PEM is as expected')
  t.strictEquals(accountId.thumbprint, accountId.key.thumbprint, 'thumbprint is as expected')
  t.deepEquals(accountId.privateJWK, accountId.key.toJWK(/* private = */ true), 'private JWK is as expected')
  t.deepEquals(accountId.publicJWK , accountId.key.toJWK(/* private = */ false), 'public JWK is as expected')

  // Test that read-only setters are actually read-only.
  ;['key', 'privatePEM', 'thumbprint', 'privateJWK', 'publicJWK', 'filePath'].forEach(readOnlySetter => {
    t.strictEquals(
      symbolOfErrorThrownBy(() => accountId[readOnlySetter] = 'dummy value'),
      Symbol.for('ReadOnlyAccessorError'),
      `attempt to set read-only property ${readOnlySetter} throws`
    )
  })

  const expectedInspectionString = dehydrate(`# Identity
  Generates, stores, loads, and saves an identity (JWT OKP key using
  Ed25519 curve) from/to file storage.
  - Identity file path: /home/aral/.small-tech.org/auto-encrypt/test/pebble/account-identity.pem
  ## Properties
  - .key        : the jose.JWK.RSAKey instance
  - .privatePEM : PEM representation of the private key
  - .thumbprint : JWK thumbprint calculated according to RFC 7638
  - .privateJWK : JavaScript object representation of JWK (private key)
  - .publicJWK  : JavaScript object representation of JWK (public key)
  - .filePath   : The file path of the private key (saved in PEM format)
  To see key details, please log() the .key property.`)

  t.strictEquals(dehydrate(util.inspect(accountId)), expectedInspectionString, 'the inspection string is as expected')

  t.end()
})
