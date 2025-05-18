//
import { Contract } from '@algorandfoundation/tealscript';
import { TokenId, Transfer, ARC11550Data, Params } from './ARC11550Data.algo';

export type AccountAppAndTokenId = {
  dataApp: AppID;
  id: TokenId;
};

export type UniversalId = uint64;

export class ARC11550Transfer extends Contract {
  /** The universalId uniquely identifies any ARC11550 token minted through this application regardless of the data app. The universal ID is generally
   * only used off-chain to smooth out the transition from ASAs (i.e wallets & explorers) and to help users easily identify individual
   * tokens */
  universalId = GlobalStateKey<UniversalId>();

  /** Maps a universal ID to an data app and an ID */
  idMapping = BoxMap<UniversalId, AccountAppAndTokenId>({ prefix: 'id' });

  createApplication() {
    this.universalId.value = 2 ** 64 - 1;
  }

  arc11550_mint(dataApp: AppID, params: Params): TokenId {
    let uid = this.universalId.value;
    this.universalId.value -= 1;

    const tokenId = sendMethodCall<typeof ARC11550Data.prototype.doMint>({ methodArgs: [params] });

    this.idMapping(uid).value = { dataApp: dataApp, id: tokenId };
    return tokenId;
  }

  arc11550_transfer(dataApp: AppID, transfers: Transfer[]) {
    const transferHookApp = sendMethodCall<typeof ARC11550Data.prototype.arc11550_transferHookApp>({
      applicationID: dataApp,
    });

    // If there is a transfer hook app, ensure that is approves the transfers
    if (transferHookApp) {
      assert(
        sendMethodCall<typeof ARC11550TransferHook.prototype.approved>({
          applicationID: transferHookApp,
          methodArgs: [this.txn.sender, transfers],
        })
      );
    }

    sendMethodCall<typeof ARC11550Data.prototype.doTransfers>({
      applicationID: dataApp,
      methodArgs: [transfers],
    });
  }
}

export class ARC11550TransferHook extends Contract {
  /** Determines whether a transfer is approved or not. This implementation always returns true, but
   * there are other possibilities such as ERC20-style approvals, whitelists, blacklists, enforced royalties, etc. */
  approved(caller: Address, transfers: Transfer[]): boolean {
    return true;
  }
}
