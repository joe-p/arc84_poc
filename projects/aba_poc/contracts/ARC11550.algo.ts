import { Contract } from '@algorandfoundation/tealscript';

export type Id = uint64;

export type Params = {
  name: bytes<32>;
  symbol: bytes<8>;
  total: uint64;
  decimals: uint64;
  manager: Address;
};

export type IdAndAddress = {
  id: Id;
  address: Address;
};

export type Transfer = {
  id: Id;
  from: Address;
  to: Address;
  amount: uint64;
};

export type MetadataKey = {
  id: Id;
  key: string;
};

export type Metadata = {
  mutable: boolean;
  data: bytes;
};

export class ARC11550 extends Contract {
  /** The ID to use for the next asset that is minted */
  nextId = GlobalStateKey<Id>();

  /** The parameters for a given asset */
  params = BoxMap<Id, Params>({ prefix: 'p' });

  /** The balance for a given user and asset */
  balances = BoxMap<IdAndAddress, uint64>({ prefix: 'b' });

  /** Arbitrary metadata for an asset that may be immutable or mutable */
  metadata = BoxMap<MetadataKey, Metadata>({ prefix: 'm' });

  /** The app to be called when a transfer is initiated, potentially rejecting it */
  transferHookApp = GlobalStateKey<AppID>();

  /** The minter can mint new tokens */
  minter = GlobalStateKey<Address>();

  createApplication(app: AppID) {
    this.transferHookApp.value = app;
    this.nextId.value = 0;
  }

  arc11550_mint(params: Params): uint64 {
    assert(this.txn.sender === this.minter.value);
    this.params(this.nextId.value).value = params;
    this.nextId.value += 1;

    return this.nextId.value - 1;
  }

  arc11550_metadata(key: MetadataKey): Metadata {
    return this.metadata(key).value;
  }

  arc11550_setMetadata(key: MetadataKey, data: bytes) {
    assert(this.txn.sender === this.params(key.id).value.manager);

    if (this.metadata(key).exists) {
      assert(this.metadata(key).value.mutable);
    }

    this.metadata(key).value.data = data;
  }

  arc11550_balanceOf(id: Id, account: Address): uint64 {
    return this.balances({ id: id, address: account }).value;
  }

  arc11550_params(id: Id): Params {
    return this.params(id).value;
  }

  arc11550_transfer(transfers: Transfer[]) {
    // If there is a transfer hook app, ensure that is approves the transfers
    if (this.transferHookApp.value.id != 0) {
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
      return;
    }

    // If there is no transfer hook app, then only allow sending of the caller's own assets
    for (let i = 0; i < transfers.length; i += 1) {
      const t = transfers[i];
      assert(t.from === this.txn.sender);
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
