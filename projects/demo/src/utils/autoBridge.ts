/* eslint-disable no-unsafe-finally */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
import { AlgorandClient, populateAppCallResources } from '@algorandfoundation/algokit-utils'
import * as algosdk from 'algosdk'
import { Arc84DataClient } from '../contracts/ARC84Data'
import { Arc84TransferClient } from '../contracts/ARC84Transfer'
import { Arc84BridgeClient, Arc84Id } from '../contracts/ARC84Bridge'
import { GenerateSwapTxnsParams, Swap } from '@tinymanorg/tinyman-js-sdk'
import { SignerTransaction } from '@txnlab/use-wallet'

export async function autoArc84ToAsa(
  group: algosdk.Transaction[],
  algod: algosdk.Algodv2,
  bridgeAppId: bigint,
): Promise<algosdk.Transaction[]> {
  const algorand = AlgorandClient.fromClients({ algod })
  const bridgeClient = new Arc84BridgeClient({ appId: bridgeAppId, algorand })

  const newTxns: algosdk.Transaction[] = []

  for (const txn of group) {
    if (txn.assetTransfer === undefined) continue
    const axfer = txn.assetTransfer

    let optInNeeded = false
    let balance: bigint
    try {
      const senderInfo = await algod.accountAssetInformation(txn.sender, axfer.assetIndex).do()
      balance = BigInt(senderInfo.assetHolding!.amount!)
    } catch (_) {
      balance = 0n
      optInNeeded = true
    }

    if (balance >= axfer.amount) continue

    let mapResult: Arc84Id | undefined
    const requiredBridgeAmount = axfer.amount - balance
    try {
      mapResult = await bridgeClient.state.box.asaToArc84Map.value(axfer.assetIndex)
    } finally {
      if (mapResult === undefined) {
        // eslint-disable-next-line no-console
        console.error(`No ARC84 token for ASA ${axfer.assetIndex}. Cannot automatically bridge`)
        return group
      }
    }

    const tokenId = mapResult.id
    const { dataApp } = mapResult

    const dataClient = new Arc84DataClient({ appId: dataApp, algorand })

    const tokenBalanceResult = await dataClient
      .newGroup()
      .arc84BalanceOf({ sender: txn.sender.toString(), args: { account: txn.sender.toString(), id: tokenId } })
      .simulate({ allowUnnamedResources: true, skipSignatures: true })

    const tokenBalance = tokenBalanceResult.returns.at(-1)?.returnValue as bigint

    if (tokenBalance < requiredBridgeAmount) return group

    if (optInNeeded) {
      newTxns.push(
        await algorand.createTransaction.assetOptIn({
          sender: txn.sender.toString(),
          assetId: axfer.assetIndex,
        }),
      )
    }

    const xferAppResult = await dataClient
      .newGroup()
      .arc84TransferApp({ sender: txn.sender.toString(), args: {} })
      .simulate({ allowUnnamedResources: true, skipSignatures: true })

    const xferApp = xferAppResult.returns[0] as bigint

    const xferClient = new Arc84TransferClient({ appId: xferApp, algorand })

    const xferCall = await xferClient.params.arc84Transfer({
      sender: txn.sender.toString(),
      args: {
        dataApp,
        transfers: [[tokenId, txn.sender.toString(), bridgeClient.appAddress.toString(), requiredBridgeAmount]],
      },
    })

    const bridgeTxns = await (
      await bridgeClient
        .newGroup()
        .arc84ToAsa({ sender: txn.sender.toString(), args: { xferCall, xferIndex: 0, receiver: txn.sender.toString() } })
        .composer()
    ).buildTransactions()

    const atc = new algosdk.AtomicTransactionComposer()
    bridgeTxns.transactions.forEach((txn) => atc.addTransaction({ txn, signer: algosdk.makeEmptyTransactionSigner() }))

    group.forEach((txn) => {
      txn.group = undefined
      atc.addTransaction({ txn, signer: algosdk.makeEmptyTransactionSigner() })
    })

    const populatedAtc = await populateAppCallResources(atc, algod)

    populatedAtc.buildGroup().forEach((t) => newTxns.push(t.txn))
  }

  return newTxns
}

const origSwapTxns = Swap.v2.generateTxns

export async function monkeyPatchTinymanV2Swap(algod: algosdk.Algodv2, bridgeAppId: bigint) {
  Swap.v2.generateTxns = async (params: GenerateSwapTxnsParams): Promise<SignerTransaction[]> => {
    const origGroup = await origSwapTxns(params)

    const autoTxns = await autoArc84ToAsa(
      origGroup.map((t) => t.txn),
      algod,
      bridgeAppId,
    )

    return autoTxns.map((t) => {
      return { txn: t, signers: origGroup[0].signers }
    })
  }
}

export async function getBalancesWithBrigedToken(
  algod: algosdk.Algodv2,
  account: algosdk.Address,
  assetId: bigint,
  bridgeAppId: bigint,
): Promise<{
  asa: {
    id: bigint
    balance: bigint
    name?: string
    symbol?: string
  }
  arc84Token: {
    id: bigint
    balance: bigint
    name?: string
    symbol?: string
  }
}> {
  let asaBalance: bigint = 0n
  let bridgedTokenBalance: bigint = 0n

  try {
    asaBalance = (await algod.accountAssetInformation(account, assetId).do()).assetHolding!.amount!
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`No balance of ASA ${assetId} for account ${account}`)
  }

  const bridgeClient = new Arc84BridgeClient({ appId: bridgeAppId, algorand: AlgorandClient.fromClients({ algod }) })
  const bridgedTokenId = await bridgeClient.state.box.asaToArc84Map.value(assetId)

  const asaInfo = await algod.getAssetByID(assetId).do()
  const decimals = BigInt(asaInfo.params.decimals!)
  const name = asaInfo.params.name

  if (bridgedTokenId === undefined) {
    return {
      asa: { name, id: assetId, balance: asaBalance / 10n ** decimals },
      arc84Token: { name, id: 0n, balance: bridgedTokenBalance / 10n ** decimals },
    }
  }

  const dataClient = new Arc84DataClient({ appId: bridgedTokenId.dataApp, algorand: AlgorandClient.fromClients({ algod }) })

  const bridgedTokenBalanceResult = await dataClient
    .newGroup()
    .arc84BalanceOf({ sender: account.toString(), args: { account: account.toString(), id: bridgedTokenId.id } })
    .simulate({ allowUnnamedResources: true, skipSignatures: true })

  bridgedTokenBalance = bridgedTokenBalanceResult.returns.at(-1)! as unknown as bigint
  return {
    asa: { name, id: assetId, balance: asaBalance / 10n ** decimals },
    arc84Token: { name, id: bridgedTokenId.id, balance: bridgedTokenBalance / 10n ** decimals },
  }
}
