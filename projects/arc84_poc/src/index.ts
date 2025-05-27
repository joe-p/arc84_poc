/* eslint-disable no-unsafe-finally */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import * as algosdk from 'algosdk';
import { Arc84DataClient } from '../contracts/clients/ARC84DataClient';
import { Arc84TransferClient } from '../contracts/clients/ARC84TransferClient';
import { Arc84BridgeClient, Arc84Id } from '../contracts/clients/ARC84BridgeClient';

export async function autoArc84ToAsa(
  group: algosdk.Transaction[],
  algod: algosdk.Algodv2,
  bridgeAppId: bigint
): Promise<algosdk.Transaction[]> {
  const algorand = AlgorandClient.fromClients({ algod });
  const bridgeClient = new Arc84BridgeClient({ appId: bridgeAppId, algorand });

  const newTxns: algosdk.Transaction[] = [];

  for (const txn of group) {
    if (txn.assetTransfer === undefined) continue;
    const axfer = txn.assetTransfer;

    let optInNeeded = false;
    let balance: bigint;
    try {
      const senderInfo = await algod.accountAssetInformation(txn.sender, axfer.assetIndex).do();
      balance = BigInt(senderInfo.assetHolding?.amount!);
    } catch (_) {
      balance = 0n;
      optInNeeded = true;
    }

    if (balance >= axfer.amount) continue;

    let mapResult: Arc84Id | undefined;
    const requiredBridgeAmount = axfer.amount - balance;
    try {
      mapResult = await bridgeClient.state.box.asaToArc84Map.value(axfer.assetIndex);
    } finally {
      if (mapResult === undefined) {
        console.log(`No ARC84 token for ASA ${axfer.assetIndex}. Cannot automatically bridge`);
        return group;
      }
    }

    const tokenId = mapResult.id;
    const { dataApp } = mapResult;

    const dataClient = new Arc84DataClient({ appId: dataApp, algorand });

    const tokenBalanceResult = await dataClient
      .newGroup()
      .arc84BalanceOf({ sender: txn.sender.toString(), args: { account: txn.sender.toString(), id: tokenId } })
      .simulate({ allowUnnamedResources: true, skipSignatures: true });

    const tokenBalance = tokenBalanceResult.returns.at(-1)?.returnValue as bigint;

    if (tokenBalance < requiredBridgeAmount) continue;

    if (optInNeeded) {
      newTxns.push(
        await algorand.createTransaction.assetOptIn({
          sender: txn.sender.toString(),
          assetId: axfer.assetIndex,
        })
      );
    }

    const xferAppResult = await dataClient
      .newGroup()
      .arc84TransferApp({ sender: txn.sender.toString(), args: {} })
      .simulate({ allowUnnamedResources: true, skipSignatures: true });

    const xferApp = xferAppResult.returns[0] as bigint;

    const xferClient = new Arc84TransferClient({ appId: xferApp, algorand });

    const xferCall = await xferClient.params.arc84Transfer({
      sender: txn.sender.toString(),
      args: {
        dataApp,
        transfers: [[tokenId, txn.sender.toString(), bridgeClient.appAddress.toString(), requiredBridgeAmount]],
      },
    });

    const bridgeTxns = await (
      await bridgeClient
        .newGroup()
        .arc84ToAsa({ sender: txn.sender, args: { xferCall, xferIndex: 0, receiver: txn.sender.toString() } })
        .composer()
    ).buildTransactions();

    newTxns.push(...bridgeTxns.transactions);
  }

  return [...newTxns, ...group];
}
