import { Contract } from '@algorandfoundation/tealscript';

export type TokenId = uint64;
export type CollectionId = uint64;

export type Transfer = {
  tokenId: TokenId;
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
  transferHookApp: AppID;
};

export type IdAndAddress = {
  tokenId: TokenId;
  address: Address;
};

export type MetadataKey = {
  /** id for collection or token depending on context */
  id: uint64;
  key: bytes;
};

export type Metadata = {
  mutable: boolean;
  data: bytes;
};

export type AllowanceKey = {
  holder: Address;
  sender: Address;
  tokenId: TokenId;
};

export type Allowance = {
  amount: uint64;
  remainingAmount: uint64;
  cooldown: uint64;
  lastUsed: uint64;
  expirationTimestamp: uint64;
};

export type Collection = {
  /** The total number of tokens minted in this collection */
  minted: uint64;

  /** The cap to total tokens that can be minted */
  mintCap: uint64;

  /** The address that can modify collection metadata and mint new tokens */
  manager: Address;
};

export class TempApp extends Contract {
  @allow.create('DeleteApplication')
  new() {}
}

export class ARC84Data extends Contract {
  /** The parameters for a given token */
  params = BoxMap<TokenId, Params>({ prefix: 'p' });

  /** The balance for a given user and token */
  balances = BoxMap<IdAndAddress, uint64>({ prefix: 'b' });

  /** Arbitrary metadata for a token that may be immutable or mutable */
  tokenMetadata = BoxMap<MetadataKey, Metadata>({ prefix: 'm' });

  /** Arbitrary metadata for a collection that may be immutable or mutable */
  collectionMetadata = BoxMap<MetadataKey, Metadata>({ prefix: 'M' });

  /** Allowances for a given sender, holder, and token id */
  allowances = BoxMap<bytes<32>, Allowance>({ prefix: 'a' });

  /** The app that implements arc84_transfer */
  transferApp = GlobalStateKey<AppID>();

  collectionId = GlobalStateKey<CollectionId>();

  collections = BoxMap<CollectionId, Collection>({ prefix: 'c' });

  createApplication(transferApp: AppID) {
    this.transferApp.value = transferApp;
  }

  arc84_newCollection(manager: Address, mintCap: uint64): CollectionId {
    const collectionId = this.collectionId.value;
    this.collectionId.value += 1;

    const collection: Collection = {
      manager: manager,
      mintCap: mintCap,
      minted: 0,
    };

    this.collections(collectionId).value = collection;

    return collectionId;
  }

  /** ***************
   * Getter Methods
   **************** */

  arc84_collection_minted(id: CollectionId): uint64 {
    return this.collections(id).value.minted;
  }

  arc84_metadata(key: MetadataKey): Metadata {
    return this.tokenMetadata(key).value;
  }

  arc84_balanceOf(id: TokenId, account: Address): uint64 {
    return this.balances({ tokenId: id, address: account }).value;
  }

  arc84_params(id: TokenId): Params {
    return this.params(id).value;
  }

  arc84_transferApp(): AppID {
    return this.transferApp.value;
  }

  arc84_transferHookApp(id: TokenId): AppID {
    return this.params(id).value.transferHookApp;
  }

  /** ********************
   * Multi Getter Methods
   ********************* */

  arc84_balancesOf(idAndAddrs: IdAndAddress[]): uint64[] {
    const balances: uint64[] = [];
    for (let i = 0; i < idAndAddrs.length; i += 1) {
      const id = idAndAddrs[i].tokenId;
      const addr = idAndAddrs[i].address;
      balances.push(this.balances({ tokenId: id, address: addr }).value);
    }

    return balances;
  }

  arc84_mulitpleParams(ids: TokenId[]): Params[] {
    const params: Params[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      params.push(this.params(id).value);
    }

    return params;
  }

  // TODO: Multi-getter for metadata

  /** ***************
   * Setter methods
   **************** */

  arc84_setMetadata(key: MetadataKey, data: bytes) {
    assert(this.txn.sender === this.params(key.id).value.manager);

    if (this.tokenMetadata(key).exists) {
      assert(this.tokenMetadata(key).value.mutable);
    }

    this.tokenMetadata(key).value.data = data;
  }

  arc84_setAllowance(allowanceKey: AllowanceKey, allowance: Allowance) {
    // FIXME: It should be the holder that can change the allowance
    assert(this.txn.sender === this.params(allowanceKey.tokenId).value.manager);
    this.allowances(sha256(rawBytes(allowanceKey))).value = allowance;
  }

  /** ********************
   * Multi Setter Methods
   ********************* */

  arc84_setAllowances(allowances: { key: AllowanceKey; allowance: Allowance }[]) {
    for (let i = 0; i < allowances.length; i += 1) {
      const a = allowances[i];
      this.arc84_setAllowance(a.key, a.allowance);
    }
  }

  // TODO: Multi-setter for metadata

  /** *********************
   * Transfer/Mint Methods
   ********************** */

  doTransfers(sender: Address, transfers: Transfer[]) {
    assert(globals.callerApplicationID === this.transferApp.value);

    for (let i = 0; i < transfers.length; i += 1) {
      const t = transfers[i];

      if (t.from !== sender) {
        const allowanceKey = sha256(
          rawBytes({
            holder: t.from,
            sender: sender,
            tokenId: t.tokenId,
          } as AllowanceKey)
        );

        assert(this.allowances(allowanceKey).exists);

        const allowance = this.allowances(allowanceKey).value;

        const currentTime = globals.latestTimestamp;
        assert(allowance.expirationTimestamp >= currentTime);

        // If there isn't enough remaining in the allowance, see if we can reset the remaining amount due to the cooldown
        if (allowance.remainingAmount < t.amount && currentTime - allowance.lastUsed >= allowance.cooldown) {
          allowance.remainingAmount = allowance.amount;
          allowance.lastUsed = currentTime;
        }

        allowance.remainingAmount -= t.amount;
      }
      this.balances({ tokenId: t.tokenId, address: t.from }).value -= t.amount;

      const recvKey: IdAndAddress = { tokenId: t.tokenId, address: t.to };
      if (!this.balances(recvKey).exists) {
        this.balances(recvKey).create();
      }
      this.balances({ tokenId: t.tokenId, address: t.to }).value += t.amount;
    }
  }

  arc84_mint(collectionId: CollectionId, params: Params): uint64 {
    const collection = this.collections(collectionId).value;

    assert(this.txn.sender === collection.manager);
    assert(collection.mintCap >= collection.minted);

    // Use an app ID for the token ID to be sure there will not be a collision with
    // ASAs
    sendMethodCall<typeof TempApp.prototype.new>({
      onCompletion: OnCompletion.DeleteApplication,
      approvalProgram: TempApp.approvalProgram(),
      clearStateProgram: TempApp.clearProgram(),
    });

    const id = this.itxn.createdApplicationID.id;

    collection.minted += 1;

    this.params(id).value = params;

    const key: IdAndAddress = { tokenId: id, address: params.manager };

    this.balances(key).create();
    this.balances(key).value = params.total;

    return id;
  }
}

export class ARC84TransferHook extends Contract {
  /** Determines whether a transfer is approved or not. This implementation just returns true (which is the same as not setting a
   * transferHookApp), but there are many possibilities such as dynamic whitelists, blacklists, enforced royalties, token-gating, etc. */
  // eslint-disable-next-line no-unused-vars
  approved(caller: Address, transfers: Transfer[]): boolean {
    return true;
  }
}
