import { Contract } from '@algorandfoundation/tealscript';

export type ARC11550Id = uint64;

export type AssetParams = {
  name: bytes<32>;
  symbol: bytes<8>;
  total: uint64;
  decmimals: uint32;
};

export type IdAndAddress = {
  id: ARC11550Id;
  address: Address;
};

export type Transfer = {
  id: ARC11550Id;
  from: Address;
  to: Address;
  amount: uint64;
};

export class ARC11550 extends Contract {
  /** The ID to use for the next asset that is minted */
  nextId = GlobalStateKey<ARC11550Id>();

  /** The parameters for a given asset */
  params = BoxMap<uint64, AssetParams>({ prefix: 'p' });

  /** The balance for a given user and asset */
  balances = BoxMap<IdAndAddress, uint64>({ prefix: 'b' });

  /** The app to be called when a transfer is initiated, potentially rejecting it */
  transferHookApp = GlobalStateKey<AppID>();

  createApplication(app: AppID) {
    this.transferHookApp.value = app;
    this.nextId.value = 0;
  }

  arc11550_name(id: ARC11550Id): bytes<32> {
    return this.params(id).value.name;
  }

  arc11550_symbol(id: ARC11550Id): bytes<8> {
    return this.params(id).value.symbol;
  }

  arc11550_decimals(id: ARC11550Id): uint32 {
    return this.params(id).value.decmimals;
  }

  arc11550_totalSupply(id: ARC11550Id): uint64 {
    return this.params(id).value.total;
  }

  arc11550_balanceOf(id: ARC11550Id, account: Address): uint64 {
    return this.balances({ id: id, address: account }).value;
  }

  arc11550_params(id: ARC11550Id): AssetParams {
    return this.params(id).value;
  }

  arc11550_transfer(transfers: Transfer[]) {
    assert(
      sendMethodCall<typeof ARC11550TransferHook.prototype.approved>({
        applicationID: this.transferHookApp.value,
        methodArgs: [this.txn.sender, transfers],
      })
    );

    for (let i = 0; i < transfers.length; i += 1) {
      const t = transfers[i];
      this.balances({ id: t.id, address: t.from }).value -= t.amount;
      this.balances({ id: t.id, address: t.to }).value += t.amount;
    }
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
