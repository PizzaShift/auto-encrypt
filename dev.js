//////////  //////////  //////////  //////////  //////////  //////////
//
// !!! Bootstrap for testing during initial development. !!!
//
// TODO: Remove once library complete.
//
//////////  //////////  //////////  //////////  //////////  //////////

const AcmeHttp01 = require('./index')

async function main () {
  // newAccount
  const acmeHttp01 = await AcmeHttp01.getSharedInstance(['dev.ar.al', 'dev2.ar.al'])
}

main()

//////////  //////////  //////////  //////////  //////////  //////////
