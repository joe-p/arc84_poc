/* eslint-disable no-unsafe-finally */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
import { AlgorandClient, populateAppCallResources } from '@algorandfoundation/algokit-utils'
import * as algosdk from 'algosdk'
import { Arc11550DataClient } from '../contracts/ARC11550Data'
import { Arc11550TransferClient } from '../contracts/ARC11550Transfer'
import { Arc11550BridgeClient, Arc11550Id } from '../contracts/ARC11550Bridge'
import { GenerateSwapTxnsParams, Swap } from '@tinymanorg/tinyman-js-sdk'
import { SignerTransaction } from '@txnlab/use-wallet'

export async function autoArc11550ToAsa(
  group: algosdk.Transaction[],
  algod: algosdk.Algodv2,
  bridgeAppId: bigint,
): Promise<algosdk.Transaction[]> {
  const algorand = AlgorandClient.fromClients({ algod })
  const bridgeClient = new Arc11550BridgeClient({ appId: bridgeAppId, algorand })

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

    let mapResult: Arc11550Id | undefined
    const requiredBridgeAmount = axfer.amount - balance
    try {
      mapResult = await bridgeClient.state.box.asaToArc11550Map.value(axfer.assetIndex)
    } finally {
      if (mapResult === undefined) {
        // eslint-disable-next-line no-console
        console.error(`No ARC11550 token for ASA ${axfer.assetIndex}. Cannot automatically bridge`)
        return group
      }
    }

    const tokenId = mapResult.id
    const { dataApp } = mapResult

    const dataClient = new Arc11550DataClient({ appId: dataApp, algorand })

    const tokenBalanceResult = await dataClient
      .newGroup()
      .arc11550BalanceOf({ sender: txn.sender.toString(), args: { account: txn.sender.toString(), id: tokenId } })
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
      .arc11550TransferApp({ sender: txn.sender.toString(), args: {} })
      .simulate({ allowUnnamedResources: true, skipSignatures: true })

    const xferApp = xferAppResult.returns[0] as bigint

    const xferClient = new Arc11550TransferClient({ appId: xferApp, algorand })

    const xferCall = await xferClient.params.arc11550Transfer({
      sender: txn.sender.toString(),
      args: {
        dataApp,
        transfers: [[tokenId, txn.sender.toString(), bridgeClient.appAddress.toString(), requiredBridgeAmount]],
      },
    })

    const bridgeTxns = await (
      await bridgeClient
        .newGroup()
        .arc11550ToAsa({ sender: txn.sender.toString(), args: { xferCall, xferIndex: 0, receiver: txn.sender.toString() } })
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

    const autoTxns = await autoArc11550ToAsa(
      origGroup.map((t) => t.txn),
      algod,
      bridgeAppId,
    )

    return autoTxns.map((t) => {
      return { txn: t, signers: origGroup[0].signers }
    })
  }
}
