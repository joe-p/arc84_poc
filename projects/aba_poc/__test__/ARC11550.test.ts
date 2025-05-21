import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config, microAlgos } from '@algorandfoundation/algokit-utils';
import { Arc11550DataFactory, Arc11550DataClient } from '../contracts/clients/ARC11550DataClient';
import { Arc11550TransferFactory, Arc11550TransferClient } from '../contracts/clients/ARC11550TransferClient';

const fixture = algorandFixture();
Config.configure({ populateAppCallResources: true });

let dataClient: Arc11550DataClient;
let xferClient: Arc11550TransferClient;
let testAccount: string;
let collectionId: bigint;
let tokenId: bigint;

function b(str: string, len?: number) {
  return new Uint8Array(Buffer.from(str.padEnd(len ?? 0, '\x00')));
}

describe('ARC11550', () => {
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

    const xferResults = await xferFactory.send.create.createApplication({ args: [] });
    xferClient = xferResults.appClient;

    const createResult = await dataFactory.send.create.createApplication({ args: [xferClient.appId] });
    dataClient = createResult.appClient;

    await algorand.account.ensureFunded(dataClient.appAddress, await algorand.account.localNetDispenser(), (10).algo());
  });

  test('newCollection', async () => {
    const result = await dataClient.send.arc11550NewCollection({
      args: {
        manager: testAccount,
        mintCap: 3,
      },
    });

    collectionId = result.return!;
  });

  test('mint', async () => {
    const result = await dataClient.send.arc11550Mint({
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
  });

  test('xfer', async () => {
    const alice = fixture.context.algorand.account.random().addr;
    const xferAmt = 50n;
    await xferClient.send.arc11550Transfer({
      extraFee: microAlgos(20_000),
      args: { dataApp: dataClient.appId, transfers: [[tokenId, testAccount, alice, xferAmt]] },
    });

    const aliceBalance = (await dataClient.send.arc11550BalanceOf({ args: { id: tokenId, account: alice } })).return;
    expect(aliceBalance).toBe(xferAmt);
  });
});
