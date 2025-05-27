import { describe, test, expect, beforeAll } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config, microAlgos } from '@algorandfoundation/algokit-utils';
import { Arc84DataFactory, Arc84DataClient } from '../contracts/clients/ARC84DataClient';
import { Arc84TransferFactory, Arc84TransferClient } from '../contracts/clients/ARC84TransferClient';

const fixture = algorandFixture();
Config.configure({ populateAppCallResources: true });

let dataClient: Arc84DataClient;
let xferClient: Arc84TransferClient;
let testAccount: string;
let collectionId: bigint;
let tokenId: bigint;

function b(str: string, len?: number) {
  return new Uint8Array(Buffer.from(str.padEnd(len ?? 0, '\x00')));
}

describe('ARC84', () => {
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

    const xferResults = await xferFactory.send.create.createApplication({ args: [] });
    xferClient = xferResults.appClient;

    const createResult = await dataFactory.send.create.createApplication({ args: [xferClient.appId] });
    dataClient = createResult.appClient;

    await algorand.account.ensureFunded(dataClient.appAddress, await algorand.account.localNetDispenser(), (10).algo());
  });

  test('newCollection', async () => {
    const result = await dataClient.send.arc84NewCollection({
      args: {
        manager: testAccount,
        mintCap: 3,
      },
    });

    collectionId = result.return!;
  });

  test('mint', async () => {
    const result = await dataClient.send.arc84Mint({
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
    const alice = fixture.context.algorand.account.random().addr.toString();
    const xferAmt = 50n;
    await xferClient.send.arc84Transfer({
      extraFee: microAlgos(20_000),
      args: { dataApp: dataClient.appId, transfers: [[tokenId, testAccount, alice, xferAmt]] },
    });

    const aliceBalance = (await dataClient.send.arc84BalanceOf({ args: { id: tokenId, account: alice } })).return;
    expect(aliceBalance).toBe(xferAmt);
  });
});
