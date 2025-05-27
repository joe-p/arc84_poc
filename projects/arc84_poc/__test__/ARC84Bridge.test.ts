import { describe, test, expect, beforeAll } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config, microAlgos } from '@algorandfoundation/algokit-utils';
import { Arc84DataFactory, Arc84DataClient } from '../contracts/clients/ARC84DataClient';
import { Arc84TransferFactory, Arc84TransferClient } from '../contracts/clients/ARC84TransferClient';
import { Arc84BridgeFactory, Arc84BridgeClient } from '../contracts/clients/ARC84BridgeClient';
import { autoArc84ToAsa } from '../src';

const fixture = algorandFixture();

Config.configure({
  populateAppCallResources: true,
  logger: { error: console.error, debug: (_) => {}, info: () => {}, warn: console.warn, verbose: () => {} },
});

function b(str: string, len?: number) {
  return new Uint8Array(Buffer.from(str.padEnd(len ?? 0, '\x00')));
}

const NEW_COLLECTION_MBR = 25_300n;
const MINT_MBR = 66_600n;
const NEW_HOLDER_MBR = 22_100n;
const BRIDGE_NEW_TOKEN_MBR = 148_300n;
const BRIDGE_NEW_ASA_MBR = 78_300n + 26_600n;

describe('ARC84 Bridge', () => {
  let dataClient: Arc84DataClient;
  let xferClient: Arc84TransferClient;
  let bridgeClient: Arc84BridgeClient;
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

    const dataFactory = new Arc84DataFactory({
      algorand,
      defaultSender: testAccount,
    });

    const xferFactory = new Arc84TransferFactory({
      algorand,
      defaultSender: testAccount,
    });

    const bridgeFactory = new Arc84BridgeFactory({
      algorand,
      defaultSender: testAccount,
    });

    // Create and fund xfer contract
    const xferResults = await xferFactory.send.create.createApplication({ args: [] });
    xferClient = xferResults.appClient;
    await algorand.send.payment({ sender: testAccount, receiver: xferClient.appAddress, amount: microAlgos(100_000) });

    // Create and fund data contract
    const createResult = await dataFactory.send.create.createApplication({ args: [xferClient.appId] });
    dataClient = createResult.appClient;
    await algorand.send.payment({ sender: testAccount, receiver: dataClient.appAddress, amount: microAlgos(100_000) });

    // Send payment for the new collection the bridge will create
    await algorand.send.payment({
      sender: testAccount,
      receiver: dataClient.appAddress,
      amount: microAlgos(NEW_COLLECTION_MBR),
    });

    // Create and fund bridge contract
    const bridgeResults = await bridgeFactory.send.create.createApplication({
      extraFee: microAlgos(1000),
      args: [dataClient.appId],
    });
    bridgeClient = bridgeResults.appClient;

    await algorand.send.payment({
      sender: testAccount,
      receiver: bridgeClient.appAddress,
      amount: microAlgos(100_000),
    });

    // Create collection
    await algorand.send.payment({
      sender: testAccount,
      receiver: dataClient.appAddress,
      amount: microAlgos(NEW_COLLECTION_MBR),
    });

    let result = await dataClient.send.arc84NewCollection({
      args: {
        manager: testAccount,
        mintCap: 3,
      },
    });

    collectionId = result.return!;

    // Mint token
    await algorand.send.payment({
      sender: testAccount,
      receiver: dataClient.appAddress,
      amount: microAlgos(MINT_MBR),
    });
    result = await dataClient.send.arc84Mint({
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

    console.debug('Accounts', {
      bridge: bridgeClient.appAddress.toString(),
      xfer: xferClient.appAddress.toString(),
      data: dataClient.appAddress.toString(),
      testAccount,
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

    // Since this is the first time the bridge holds this asset, we need to send MBR for the balance/approval boxes
    await algorand.send.payment({
      sender: testAccount,
      receiver: dataClient.appAddress,
      amount: microAlgos(NEW_HOLDER_MBR),
    });

    await algorand.send.payment({
      sender: testAccount,
      receiver: bridgeClient.appAddress,
      amount: microAlgos(BRIDGE_NEW_TOKEN_MBR),
    });

    const xferAmt = 50n;
    const xfer = await xferClient.params.arc84Transfer({
      extraFee: microAlgos(20_000),
      args: {
        dataApp: dataClient.appId,
        transfers: [[tokenId, testAccount, bridgeClient.appAddress.toString(), xferAmt]],
      },
    });

    const bridgeResult = await bridgeClient.send.arc84ToAsa({
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
    const xfer = await xferClient.params.arc84Transfer({
      extraFee: microAlgos(20_000),
      args: {
        dataApp: dataClient.appId,
        transfers: [[tokenId, testAccount, bridgeClient.appAddress.toString(), xferAmt]],
      },
    });

    const bridgeResult = await bridgeClient.send.arc84ToAsa({
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

    await algorand.send.payment({
      sender: testAccount,
      receiver: bridgeClient.appAddress,
      amount: microAlgos(BRIDGE_NEW_ASA_MBR),
    });

    await algorand.send.payment({
      sender: testAccount,
      receiver: dataClient.appAddress,
      amount: microAlgos(MINT_MBR + NEW_HOLDER_MBR),
    });
    const results = await bridgeClient
      .newGroup()
      .optInToAsa({ extraFee: microAlgos(1000), args: { asa: nativeAsa } })
      .asaToArc84({ extraFee: microAlgos(6000), args: { axfer: xfer, receiver: testAccount } })
      .send();

    bridgedToken = results.returns.at(-1) as any;

    const balanceRes = await dataClient.send.arc84BalanceOf({ args: { account: testAccount, id: bridgedToken.id } });
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
      .asaToArc84({ extraFee: microAlgos(6000), args: { axfer: xfer, receiver: testAccount } })
      .send();

    bridgedToken = results.returns.at(-1) as any;

    const balanceRes = await dataClient.send.arc84BalanceOf({ args: { account: testAccount, id: bridgedToken.id } });
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

    const autoGroup = await autoArc84ToAsa(axferGroup.transactions, algorand.client.algod, bridgeClient.appId);

    // Group is now:
    // 1. arc84 xfer to bridge
    // 2. bridge
    // 3. axfer
    expect(autoGroup.length).toBe(3);

    const groupForSending = algorand.newGroup();

    autoGroup.forEach((t) => groupForSending.addTransaction(t));

    groupForSending.send();
  });
});
