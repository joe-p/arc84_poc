import { Contract } from '@algorandfoundation/tealscript';
import { Transfer, ARC84Data } from './ARC84Data.algo';

export class ARC84TransferHook extends Contract {
  /** Determines whether a transfer is approved or not. This implementation always returns true, but
   * there are other possibilities such as ERC20-style approvals, whitelists, blacklists, enforced royalties, etc. */
  // eslint-disable-next-line no-unused-vars
  approved(caller: Address, transfers: Transfer[], idx: uint64): boolean {
    return true;
  }
}

export class ARC84Transfer extends Contract {
  arc84_transfer(dataApp: AppID, transfers: Transfer[]) {
    for (let i = 0; i < transfers.length; i += 1) {
      const transferHookApp = sendMethodCall<typeof ARC84Data.prototype.arc84_transferHookApp>({
        methodArgs: [transfers[i].tokenId],
        applicationID: dataApp,
      });

      // If there is a transfer hook app, ensure that it approves the transfer
      if (transferHookApp) {
        assert(
          sendMethodCall<typeof ARC84TransferHook.prototype.approved>({
            applicationID: transferHookApp,
            methodArgs: [this.txn.sender, transfers, i],
          })
        );
      }
    }

    sendMethodCall<typeof ARC84Data.prototype.doTransfers>({
      applicationID: dataApp,
      methodArgs: [this.txn.sender, transfers],
    });
  }
}
