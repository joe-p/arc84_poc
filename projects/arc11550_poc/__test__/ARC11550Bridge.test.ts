import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config, microAlgos } from '@algorandfoundation/algokit-utils';
import { Arc11550DataFactory, Arc11550DataClient } from '../contracts/clients/ARC11550DataClient';
import { Arc11550TransferFactory, Arc11550TransferClient } from '../contracts/clients/ARC11550TransferClient';
import { Arc11550BridgeFactory, Arc11550BridgeClient, Arc11550Id } from '../contracts/clients/ARC11550BridgeClient';
import { autoArc11550ToAsa } from '../src';

const fixture = algorandFixture();

Config.configure({
  populateAppCallResources: true,
  logger: { error: console.error, debug: (_) => {}, info: () => {}, warn: console.warn, verbose: () => {} },
});

function b(str: string, len?: number) {
  return new Uint8Array(Buffer.from(str.padEnd(len ?? 0, '\x00')));
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
