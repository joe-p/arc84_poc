#!/usr/bin/env bun

/* eslint-disable no-console */
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import process, { exit } from 'process'
import { Arc84BridgeClient, Arc84BridgeFactory } from '../src/contracts/ARC84Bridge'
import { Arc84DataClient, Arc84DataFactory } from '../src/contracts/ARC84Data'
import { Arc84TransferClient, Arc84TransferFactory } from '../src/contracts/ARC84Transfer'
import 'dotenv/config'

export const USDC_ASA_ID = 10458941n
const NEW_COLLECTION_MBR = 25_300n
const MINT_MBR = 66_600n
const NEW_HOLDER_MBR = 22_100n
const BRIDGE_NEW_ASA_MBR = 78_300n + 26_600n

const BRIDGED_USDC_TOKEN_ID = process.env.BRIDGED_USDC_TOKEN_ID
const DATA_APP_ID = process.env.DATA_APP_ID
const XFER_APP_ID = process.env.XFER_APP_ID
const BRIDGE_APP_ID = process.env.BRIDGE_APP_ID

const DEMO_USDC_BALANCE = 5_000_000n

async function createContracts(algorand: AlgorandClient, usdcAcct: algosdk.Address) {
  console.log(`Creating contracts...`)

  const dataFactory = new Arc84DataFactory({
    algorand,
    defaultSender: usdcAcct,
  })

  const xferFactory = new Arc84TransferFactory({
    algorand,
    defaultSender: usdcAcct,
  })

  const bridgeFactory = new Arc84BridgeFactory({
    algorand,
    defaultSender: usdcAcct,
  })

  // Create and fund xfer contract
  console.log(`Creating xfer contract...`)
  const xferResults = await xferFactory.send.create.createApplication({ args: [] })
  const xferClient = xferResults.appClient
  await algorand.send.payment({ sender: usdcAcct, receiver: xferClient.appAddress, amount: microAlgos(100_000) })

  // Create and fund data contract
  console.log(`Creating data contract...`)
  const createResult = await dataFactory.send.create.createApplication({ args: [xferClient.appId] })
  const dataClient = createResult.appClient
  await algorand.send.payment({ sender: usdcAcct, receiver: dataClient.appAddress, amount: microAlgos(100_000) })

  // Send payment for the new collection the bridge will create

  console.log(`Creating bridge contract...`)
  await algorand.send.payment({
    sender: usdcAcct,
    receiver: dataClient.appAddress,
    amount: microAlgos(NEW_COLLECTION_MBR),
  })

  // Create and fund bridge contract
  const bridgeResults = await bridgeFactory.send.create.createApplication({
    extraFee: microAlgos(1000),
    args: [dataClient.appId],
  })
  const bridgeClient = bridgeResults.appClient

  await algorand.send.payment({
    sender: usdcAcct,
    receiver: bridgeClient.appAddress,
    amount: microAlgos(200_000),
  })

  console.log('Apps created. Please set following env variables and run the script again:')
  console.log(`DATA_APP_ID=${dataClient.appId}`)
  console.log(`XFER_APP_ID=${xferClient.appId}`)
  console.log(`BRIDGE_APP_ID=${bridgeClient.appId}`)

  exit(1)
}

async function createBridgedUSDC(
  algorand: AlgorandClient,
  testAccount: algosdk.Address,
  bridgeClient: Arc84BridgeClient,
  dataClient: Arc84DataClient,
) {
  const xfer = await algorand.createTransaction.assetTransfer({
    sender: testAccount,
    receiver: bridgeClient.appAddress,
    assetId: USDC_ASA_ID,
    amount: 1n,
  })

  const bridgePay = await algorand.createTransaction.payment({
    sender: testAccount,
    receiver: bridgeClient.appAddress,
    amount: microAlgos(BRIDGE_NEW_ASA_MBR + 21_700n),
  })

  const dataPay = await algorand.createTransaction.payment({
    sender: testAccount,
    receiver: dataClient.appAddress,
    amount: microAlgos(MINT_MBR + 2n * NEW_HOLDER_MBR),
  })
  const results = await bridgeClient
    .newGroup()
    .addTransaction(bridgePay)
    .addTransaction(dataPay)
    .optInToAsa({ extraFee: microAlgos(1000), args: { asa: USDC_ASA_ID }, sender: testAccount })
    .asaToArc84({ sender: testAccount, extraFee: microAlgos(6000), args: { axfer: xfer, receiver: testAccount.toString() } })
    .send()

  const bridgedToken = results.returns.at(-1) as unknown as { id: bigint; dataApp: bigint }
  console.log('Set the following env variable and run the script again:')
  console.log(`BRIDGED_USDC_TOKEN_ID=${bridgedToken.id}`)

  exit(1)
}

export async function setup() {
  const algorand = AlgorandClient.testNet()

  let demoAddr: algosdk.Address = algosdk.Address.zeroAddress()
  let usdcAddr: algosdk.Address = algosdk.Address.zeroAddress()

  try {
    demoAddr = (await algorand.account.fromEnvironment('DEMO')).addr
    usdcAddr = (await algorand.account.fromEnvironment('USDC_HOLDER')).addr

    console.info(`DEMO_ADDR=${demoAddr}`)
    console.info(`USDC_ADDR=${usdcAddr}`)
  } catch (e) {
    const accounts = [algorand.account.random(), algorand.account.random()].map((a) => algosdk.secretKeyToMnemonic(a.account.sk))
    console.error('Please set the DEMO_MNEMONIC and USDC_HOLDER_MNEMONIC environment variables')
    console.error(`DEMO_MNEMONIC=${accounts[0]}`)
    console.error(`USDC_HOLDER_MNEMONIC=${accounts[1]}`)
    exit(1)
  }

  const getUnderFundedAccounts = async () => {
    const demoBalance = (await algorand.account.getInformation(demoAddr)).balance.microAlgo
    const usdcBalance = (await algorand.account.getInformation(usdcAddr)).balance.microAlgo

    const addrsNeedingAlgo: algosdk.Address[] = []
    if (demoBalance < 100_000) addrsNeedingAlgo.push(demoAddr)
    if (usdcBalance < 100_000) addrsNeedingAlgo.push(usdcAddr)

    return addrsNeedingAlgo
  }

  const underFundedAccounts = await getUnderFundedAccounts()
  if (underFundedAccounts.length > 0) {
    console.debug('The following addresses need to be funded with Algo:')
    console.debug(underFundedAccounts.map((a) => a.toString()).join('\n'))

    while ((await getUnderFundedAccounts()).length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  const getUsdcBalance = async () => {
    try {
      const usdcInfo = await algorand.asset.getAccountInformation(usdcAddr, USDC_ASA_ID)
      return usdcInfo.balance
    } catch (e) {
      await algorand.send.assetOptIn({ assetId: USDC_ASA_ID, sender: usdcAddr })
      return 0n
    }
  }

  const usdcBalance = await getUsdcBalance()
  if (usdcBalance < 2n * DEMO_USDC_BALANCE) {
    console.debug(`The following account get more USDC: ${usdcAddr}`)
    while ((await getUsdcBalance()) < 2n * DEMO_USDC_BALANCE) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  let demoUsdcBalance: bigint = 0n
  try {
    demoUsdcBalance = (await algorand.asset.getAccountInformation(demoAddr, USDC_ASA_ID)).balance
  } catch (e) {
    console.debug('Opting demo account in to USDC...')
    await algorand.send.assetOptIn({ assetId: USDC_ASA_ID, sender: demoAddr })
  } finally {
    if (demoUsdcBalance < DEMO_USDC_BALANCE) {
      console.debug(`Ensuring demo account has ${DEMO_USDC_BALANCE} USDC...`)
      const txn = await algorand.createTransaction.assetTransfer({
        assetId: USDC_ASA_ID,
        sender: usdcAddr,
        receiver: demoAddr,
        amount: DEMO_USDC_BALANCE - demoUsdcBalance,
      })

      console.debug(txn)
      await algorand.newGroup().addTransaction(txn).send()
    } else if (demoUsdcBalance > DEMO_USDC_BALANCE) {
      console.debug(`Ensuring demo account has ${DEMO_USDC_BALANCE} USDC...`)
      await algorand.send.assetTransfer({
        assetId: USDC_ASA_ID,
        sender: demoAddr,
        receiver: usdcAddr,
        amount: demoUsdcBalance - DEMO_USDC_BALANCE,
      })
    }
  }

  console.log(`ALGO and USDC balances ready!`)

  if (DATA_APP_ID === undefined || XFER_APP_ID === undefined || BRIDGE_APP_ID === undefined) {
    await createContracts(algorand, usdcAddr)
  }

  const dataClient = new Arc84DataClient({ algorand, appId: BigInt(DATA_APP_ID!) })
  const xferClient = new Arc84TransferClient({ algorand, appId: BigInt(XFER_APP_ID!) })
  const bridgeClient = new Arc84BridgeClient({ algorand, appId: BigInt(BRIDGE_APP_ID!) })

  console.info('Using the follow contracts')
  console.info({
    data: {
      appId: dataClient.appId,
      address: dataClient.appAddress.toString(),
    },
    xfer: {
      appId: xferClient.appId,
      address: xferClient.appAddress.toString(),
    },
    bridge: {
      appId: bridgeClient.appId,
      address: bridgeClient.appAddress.toString(),
    },
  })

  if (BRIDGED_USDC_TOKEN_ID === undefined) {
    await createBridgedUSDC(algorand, usdcAddr, bridgeClient, dataClient)
    exit(1)
  }

  const tokenId = BigInt(BRIDGED_USDC_TOKEN_ID)

  let demoTokenBalance: bigint = 0n
  try {
    const result = await dataClient
      .newGroup()
      .arc84BalanceOf({ sender: demoAddr.toString(), args: { account: demoAddr.toString(), id: tokenId } })
      .simulate({ allowUnnamedResources: true, skipSignatures: true })

    console.debug(result.returns[0])
    demoTokenBalance = result.returns[0] as bigint
  } catch (e) {
    // Do nothing
  }

  if (demoTokenBalance < 5_000_000n) {
    console.log(`Ensuring demo account has 5 USDC ARC84 tokens...`)
    const axfer = await algorand.createTransaction.assetTransfer({
      sender: usdcAddr,
      receiver: bridgeClient.appAddress,
      assetId: USDC_ASA_ID,
      amount: 5_000_000n - demoTokenBalance,
    })

    await bridgeClient.send.asaToArc84({ sender: usdcAddr, args: { axfer, receiver: demoAddr.toString() } })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setup()
}
