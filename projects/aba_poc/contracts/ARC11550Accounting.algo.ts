import { Contract } from '@algorandfoundation/tealscript';

export type Id = uint64;

export type Transfer = {
  id: Id;
  from: Address;
  to: Address;
  amount: uint64;
};

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

export type MetadataKey = {
  id: Id;
  key: string;
};

export type Metadata = {
  mutable: boolean;
  data: bytes;
};

export type AllowanceKey = {
  holder: Address;
  sender: Address;
  id: Id;
};

export type Allowance = {
  amount: uint64;
  untilTimestamp: uint64;
};

export class ARC11550Accounting extends Contract {
  /** The total number of tokens minted. This is used to calculate the token IDs */
  minted = GlobalStateKey<Id>();

  /** The parameters for a given asset */
  params = BoxMap<Id, Params>({ prefix: 'p' });

  /** The balance for a given user and asset */
  balances = BoxMap<IdAndAddress, uint64>({ prefix: 'b' });

  /** Arbitrary metadata for an asset that may be immutable or mutable */
  metadata = BoxMap<MetadataKey, Metadata>({ prefix: 'm' });

  /** The app that implements arc11550_transfer */
  transferApp = GlobalStateKey<AppID>();

  /** The cap to total tokens that can be minted */
  mintCap = GlobalStateKey<uint64>();

  /** The minter can mint new tokens */
  minter = GlobalStateKey<Address>();

  /** Allowances for a given sender, holder, and asset id */
  allowances = BoxMap<AllowanceKey, Allowance>({ prefix: 'a' });

  createApplication(transferApp: AppID, mintCap: uint64) {
    this.transferApp.value = transferApp;
    this.minted.value = 0;
    this.mintCap.value = mintCap;
  }

  arc11550_minted(): uint64 {
    return this.minted.value;
  }

  arc11550_metadata(key: MetadataKey): Metadata {
    return this.metadata(key).value;
  }

  // TODO: Nested dynamic types not supported by TEALScript
  // arc11550_multipleMetadata(keys: MetadataKey[]): Metadata[] {
  //   const metadata: Metadata[] = [];
  //   for (let i = 0; i < keys.length; i += 1) {
  //     const key = keys[i];
  //     metadata[i] = this.metadata(key).value;
  //   }
  //
  //   return metadata;
  // }

  arc11550_setMetadata(key: MetadataKey, data: bytes) {
    assert(this.txn.sender === this.params(key.id).value.manager);

    if (this.metadata(key).exists) {
      assert(this.metadata(key).value.mutable);
    }

    this.metadata(key).value.data = data;
  }

  // TODO: Nested dynamic types not supported by TEALScript
  // arc11550_setMultipleMetadata(keysAndData: { key: MetadataKey; data: bytes }[]) {
  //   for (let i = 0; i < keysAndData.length; i += 1) {
  //     this.arc11550_setMetadata(keysAndData[i].key, keysAndData[i].data);
  //   }
  // }

  arc11550_balanceOf(id: Id, account: Address): uint64 {
    return this.balances({ id: id, address: account }).value;
  }

  arc11550_balancesOf(idAndAddrs: IdAndAddress[]): uint64[] {
    const balances: uint64[] = [];
    for (let i = 0; i < idAndAddrs.length; i += 1) {
      const id = idAndAddrs[i].id;
      const addr = idAndAddrs[i].address;
      balances.push(this.balances({ id: id, address: addr }).value);
    }

    return balances;
  }

  arc11550_params(id: Id): Params {
    return this.params(id).value;
  }

  arc11550_mulitpleParams(ids: Id[]): Params[] {
    const params: Params[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      params.push(this.params(id).value);
    }

    return params;
  }

  arc11550_approve(allowanceKey: AllowanceKey, allowance: Allowance) {
    assert(this.txn.sender === this.params(allowanceKey.id).value.manager);
    this.allowances(allowanceKey).value = allowance;
  }

  arc11550_setApprovals(allowances: { key: AllowanceKey; allowance: Allowance }[]) {
    for (let i = 0; i < allowances.length; i += 1) {
      const a = allowances[i];
      this.arc11550_approve(a.key, a.allowance);
    }
  }

  doTransfers(transfers: Transfer[]) {
    assert(globals.callerApplicationID == this.transferApp.value);

    for (let i = 0; i < transfers.length; i += 1) {
      const t = transfers[i];

      if (t.from !== this.txn.sender) {
        const allowance = this.allowances({ holder: t.from, sender: this.txn.sender, id: t.id } as AllowanceKey).value;
        assert(allowance.untilTimestamp >= globals.latestTimestamp);
        allowance.amount -= t.amount;
      }
      this.balances({ id: t.id, address: t.from }).value -= t.amount;
      this.balances({ id: t.id, address: t.to }).value += t.amount;
    }
  }

  doMint(params: Params): uint64 {
    assert(globals.callerApplicationID == this.transferApp.value);

    const id = this.minted.value;
    assert(id <= this.mintCap.value);
    assert(this.txn.sender === this.minter.value);

    this.params(id).value = params;
    this.minted.value += 1;

    return id;
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
