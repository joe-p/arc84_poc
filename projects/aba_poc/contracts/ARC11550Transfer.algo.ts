//
import { Contract } from '@algorandfoundation/tealscript';
import { Id, Transfer, ARC11550Accounting, Params } from './ARC11550Accounting.algo';

export type AccountAppAndAssetId = {
  accountingApp: AppID;
  id: Id;
};

export type UniversalId = uint64;

export class ARC11550Transfer extends Contract {
  /** Maps a universal ID to an accounting app and an ID */
  idMapping = BoxMap<UniversalId, AccountAppAndAssetId>({ prefix: 'id' });

  /** Uniquely identify any ARC11550 asset minted through this application regardless of the account app. The universal ID is generally
   * only used off-chain to smooth out the transition from ASAs (i.e wallets & explorers) and to help users easily identify individual
   * tokens */
  universalId = GlobalStateKey<UniversalId>();

  createApplication() {
    this.universalId.value = 2 ** 64 - 1;
  }

  arc11550_mint(accountingApp: AppID, params: Params): Id {
    let uid = this.universalId.value;
    this.universalId.value -= 1;

    const assetId = sendMethodCall<typeof ARC11550Accounting.prototype.doMint>({ methodArgs: [params] });

    this.idMapping(uid).value = { accountingApp: accountingApp, id: assetId };
    return assetId;
  }

  arc11550_transfer(accountingApp: AppID, transfers: Transfer[]) {
    const transferHookApp = sendMethodCall<typeof ARC11550Accounting.prototype.arc11550_transferHookApp>({
      applicationID: accountingApp,
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

    sendMethodCall<typeof ARC11550Accounting.prototype.doTransfers>({
      applicationID: accountingApp,
      methodArgs: [transfers],
    });
  }
}

export class ARC11550TransferHook extends Contract {
  /** Determines whether a transfer is approved or not. This implementation just ensures the caller is sending from their own address, but
   * there are other possibilities such as ERC20-style approvals, whitelists, blacklists, enforced royalties, etc. */
  approved(caller: Address, transfers: Transfer[]): boolean {
    for (let i = 0; i < transfers.length; i += 1) {
      const t = transfers[i];
      if (t.from !== caller) return false;
    }

    return true;
  }
}
