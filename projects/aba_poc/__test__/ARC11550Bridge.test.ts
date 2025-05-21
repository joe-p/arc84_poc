import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config, microAlgos } from '@algorandfoundation/algokit-utils';
import { Arc11550DataFactory, Arc11550DataClient } from '../contracts/clients/ARC11550DataClient';
import { Arc11550TransferFactory, Arc11550TransferClient } from '../contracts/clients/ARC11550TransferClient';
import { Arc11550BridgeFactory, Arc11550BridgeClient } from '../contracts/clients/ARC11550BridgeClient';
import * as algosdk from 'algosdk';
const fixture = algorandFixture();
Config.configure({ populateAppCallResources: true });

let dataClient: Arc11550DataClient;
let xferClient: Arc11550TransferClient;
let bridgeClient: Arc11550BridgeClient;
let testAccount: string;
let collectionId: bigint;
let tokenId: bigint;
let bridgedAsa: bigint;
let nativeAsa: bigint;

function b(str: string, len?: number) {
  return new Uint8Array(Buffer.from(str.padEnd(len ?? 0, '\x00')));
}

describe('ARC11550 Bridge', () => {
  beforeAll(async () => {
    await fixture.newScope();
    testAccount = fixture.context.testAccount.addr;
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
          total: 1337n,
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
      bridge: bridgeClient.appAddress,
      xfer: xferClient.appAddress,
      data: dataClient.appAddress,
      testAccount: testAccount,
    });

    nativeAsa = (
      await algorand.send.assetCreate({
        sender: testAccount,
        total: 1337n,
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
      args: { dataApp: dataClient.appId, transfers: [[tokenId, testAccount, bridgeClient.appAddress, xferAmt]] },
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
      args: { dataApp: dataClient.appId, transfers: [[tokenId, testAccount, bridgeClient.appAddress, xferAmt]] },
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

    const xferAmount = 50n;
    const xfer = await algorand.createTransaction.assetTransfer({
      sender: testAccount,
      receiver: bridgeClient.appAddress,
      assetId: nativeAsa,
      amount: xferAmount,
    });

    await bridgeClient
      .newGroup()
      .optInToAsa({ extraFee: microAlgos(1000), args: { asa: nativeAsa } })
      .asaToArc11550({ extraFee: microAlgos(6000), args: { axfer: xfer, receiver: testAccount } })
      .send();
  });
});
