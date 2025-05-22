import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { AlgorandClient, Config, microAlgos } from '@algorandfoundation/algokit-utils';
import { Arc11550DataFactory, Arc11550DataClient } from '../contracts/clients/ARC11550DataClient';
import { Arc11550TransferFactory, Arc11550TransferClient } from '../contracts/clients/ARC11550TransferClient';
import { Arc11550BridgeFactory, Arc11550BridgeClient, Arc11550Id } from '../contracts/clients/ARC11550BridgeClient';
import * as algosdk from 'algosdk';
const fixture = algorandFixture();

Config.configure({
  populateAppCallResources: true,
  logger: { error: console.error, debug: (_) => {}, info: () => {}, warn: console.warn, verbose: () => {} },
});

function b(str: string, len?: number) {
  return new Uint8Array(Buffer.from(str.padEnd(len ?? 0, '\x00')));
}

async function autoArc11550ToAsa(
  group: algosdk.Transaction[],
  algod: algosdk.Algodv2,
  bridgeAppId: bigint
): Promise<algosdk.Transaction[]> {
  const algorand = AlgorandClient.fromClients({ algod });
  const bridgeClient = new Arc11550BridgeClient({ appId: bridgeAppId, algorand });

  const newTxns: algosdk.Transaction[] = [];

  await Promise.all(
    [...group].map(async (txn) => {
      if (txn.assetTransfer === undefined) return;
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

      if (balance >= axfer.amount) return;

      let mapResult: Arc11550Id | undefined;
      const requiredBridgeAmount = axfer.amount - balance;
      try {
        mapResult = await bridgeClient.state.box.asaToArc11550Map.value(axfer.assetIndex);
      } finally {
        if (mapResult === undefined) {
          console.log(`No ARC11550 token for ASA ${axfer.assetIndex}. Cannot automatically bridge`);
          return group;
        }
      }

      const tokenId = mapResult.id;
      const dataApp = mapResult.dataApp;

      const dataClient = new Arc11550DataClient({ appId: dataApp, algorand });

      const tokenBalanceResult = await dataClient
        .newGroup()
        .arc11550BalanceOf({ sender: txn.sender.toString(), args: { account: txn.sender.toString(), id: tokenId } })
        .simulate({ allowUnnamedResources: true, skipSignatures: true });

      const tokenBalance = tokenBalanceResult.returns.at(-1)?.returnValue as bigint;

      if (tokenBalance < requiredBridgeAmount) return;

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
        .arc11550TransferApp({ sender: txn.sender.toString(), args: {} })
        .simulate({ allowUnnamedResources: true, skipSignatures: true });

      const xferApp = xferAppResult.returns[0] as bigint;

      const xferClient = new Arc11550TransferClient({ appId: xferApp, algorand });

      const xferCall = await xferClient.params.arc11550Transfer({
        sender: txn.sender.toString(),
        args: {
          dataApp,
          transfers: [[tokenId, txn.sender.toString(), bridgeClient.appAddress.toString(), requiredBridgeAmount]],
        },
      });

      const bridgeTxns = await (
        await bridgeClient
          .newGroup()
          .arc11550ToAsa({ sender: txn.sender, args: { xferCall, xferIndex: 0, receiver: txn.sender.toString() } })
          .composer()
      ).buildTransactions();

      newTxns.push(...bridgeTxns.transactions);
    })
  );

  return [...newTxns, ...group];
}

describe('ARC11550 Bridge', () => {
  let dataClient: Arc11550DataClient;
  let xferClient: Arc11550TransferClient;
  let bridgeClient: Arc11550BridgeClient;
  let testAccount: string;
  let collectionId: bigint;
  let tokenId: bigint;
  let bridgedAsa: bigint;
  let nativeAsa: bigint;
  let bridgedToken: { id: bigint; account: string };
  beforeAll(async () => {
    await fixture.newScope();
    testAccount = fixture.context.testAccount.addr.toString();
    const { algorand } = fixture;

    algorand.setSuggestedParamsCacheTimeout(0);

    const dataFactory = new Arc11550DataFactory({
      algorand,
      defaultSender: testAccount,
    });

    const xferFactory = new Arc11550TransferFactory({
      algorand,
      defaultSender: testAccount,
    });

    const bridgeFactory = new Arc11550BridgeFactory({
      algorand,
      defaultSender: testAccount,
    });

    const xferResults = await xferFactory.send.create.createApplication({ args: [] });
    xferClient = xferResults.appClient;

    const createResult = await dataFactory.send.create.createApplication({ args: [xferClient.appId] });
    dataClient = createResult.appClient;

    await algorand.account.ensureFunded(dataClient.appAddress, await algorand.account.localNetDispenser(), (10).algo());

    // Create collection
    let result = await dataClient.send.arc11550NewCollection({
      args: {
        manager: testAccount,
        mintCap: 3,
      },
    });

    collectionId = result.return!;

    // Mint token
    result = await dataClient.send.arc11550Mint({
      extraFee: microAlgos(1000),
      args: {
        collectionId,
        params: {
          name: b('test token', 32),
          symbol: b('tt', 8),
          decimals: 0n,
          total: 10_000n,
          manager: testAccount,
          transferHookApp: 0n,
        },
      },
    });

    tokenId = result.return!;

    // Create bridge contract
    const bridgeResults = await bridgeFactory.send.create.createApplication({
      extraFee: microAlgos(1000),
      args: [dataClient.appId],
    });
    bridgeClient = bridgeResults.appClient;

    await algorand.account.ensureFunded(
      bridgeClient.appAddress,
      await algorand.account.localNetDispenser(),
      (10).algo()
    );

    console.debug('Accounts', {
      bridge: bridgeClient.appAddress.toString(),
      xfer: xferClient.appAddress.toString(),
      data: dataClient.appAddress.toString(),
      testAccount: testAccount,
    });

    nativeAsa = (
      await algorand.send.assetCreate({
        sender: testAccount,
        total: 10_000n,
        assetName: 'native asa',
        unitName: 'nASA',
      })
    ).assetId;
  });

  test('new sc to asa', async () => {
    const { algorand } = fixture.context;
    const xferAmt = 50n;
    const xfer = await xferClient.params.arc11550Transfer({
      extraFee: microAlgos(20_000),
      args: {
        dataApp: dataClient.appId,
        transfers: [[tokenId, testAccount, bridgeClient.appAddress.toString(), xferAmt]],
      },
    });

    const bridgeResult = await bridgeClient.send.arc11550ToAsa({
      args: { xferCall: xfer, xferIndex: 0, receiver: testAccount },
    });

    bridgedAsa = bridgeResult.return!;

    await algorand.send.assetOptIn({ sender: testAccount, assetId: bridgedAsa });
    await bridgeClient.send.withdrawAsa({
      extraFee: microAlgos(1000),
      args: { asa: bridgedAsa, withdrawalFor: testAccount },
    });

    const asaAcctInfo = await algorand.asset.getAccountInformation(testAccount, bridgedAsa);

    expect(asaAcctInfo.balance).toBe(50n);
  });

  test('existing sc to asa', async () => {
    const { algorand } = fixture.context;
    const xferAmt = 50n;
    const xfer = await xferClient.params.arc11550Transfer({
      extraFee: microAlgos(20_000),
      args: {
        dataApp: dataClient.appId,
        transfers: [[tokenId, testAccount, bridgeClient.appAddress.toString(), xferAmt]],
      },
    });

    const bridgeResult = await bridgeClient.send.arc11550ToAsa({
      args: { xferCall: xfer, xferIndex: 0, receiver: testAccount },
    });

    expect(bridgeResult.return!).toBe(bridgedAsa);

    const asaAcctInfo = await algorand.asset.getAccountInformation(testAccount, bridgedAsa);

    expect(asaAcctInfo.balance).toBe(100n);
  });

  test('new asa to sc', async () => {
    const { algorand } = fixture.context;

    const xferAmount = 42n;
    const xfer = await algorand.createTransaction.assetTransfer({
      sender: testAccount,
      receiver: bridgeClient.appAddress,
      assetId: nativeAsa,
      amount: xferAmount,
    });

    const results = await bridgeClient
      .newGroup()
      .optInToAsa({ extraFee: microAlgos(1000), args: { asa: nativeAsa } })
      .asaToArc11550({ extraFee: microAlgos(6000), args: { axfer: xfer, receiver: testAccount } })
      .send();

    bridgedToken = results.returns.at(-1) as any;

    const balanceRes = await dataClient.send.arc11550BalanceOf({ args: { account: testAccount, id: bridgedToken.id } });
    expect(balanceRes.return).toBe(xferAmount);
  });

  test('asa to sc', async () => {
    const { algorand } = fixture.context;

    const xferAmount = 42n;
    const xfer = await algorand.createTransaction.assetTransfer({
      sender: testAccount,
      receiver: bridgeClient.appAddress,
      assetId: nativeAsa,
      amount: xferAmount,
    });

    const results = await bridgeClient
      .newGroup()
      .optInToAsa({ extraFee: microAlgos(1000), args: { asa: nativeAsa } })
      .asaToArc11550({ extraFee: microAlgos(6000), args: { axfer: xfer, receiver: testAccount } })
      .send();

    bridgedToken = results.returns.at(-1) as any;

    const balanceRes = await dataClient.send.arc11550BalanceOf({ args: { account: testAccount, id: bridgedToken.id } });
    expect(balanceRes.return).toBe(xferAmount * 2n);
  });

  test('auto sc to asa: has some ASA, but not enough', async () => {
    const { algorand } = fixture.context;

    const alice = algorand.account.random();
    await algorand.account.ensureFunded(alice, await algorand.account.localNetDispenser(), microAlgos(10_000_000));
    await algorand.send.assetOptIn({ sender: alice, assetId: nativeAsa });

    const currentAsaBalance = await algorand.client.algod.accountAssetInformation(testAccount, nativeAsa).do();

    // Group starts as:
    // 1. axfer
    const axferGroup = await algorand
      .newGroup()
      .addAssetTransfer({
        assetId: nativeAsa,
        amount: currentAsaBalance.assetHolding!.amount + 50n,
        sender: testAccount,
        receiver: bridgeClient.appAddress,
      })
      .buildTransactions();

    const autoGroup = await autoArc11550ToAsa(axferGroup.transactions, algorand.client.algod, bridgeClient.appId);

    // Group is now:
    // 1. arc11550 xfer to bridge
    // 2. bridge
    // 3. axfer
    expect(autoGroup.length).toBe(3);

    const groupForSending = algorand.newGroup();

    autoGroup.forEach((t) => groupForSending.addTransaction(t));

    groupForSending.send();
  });
});
