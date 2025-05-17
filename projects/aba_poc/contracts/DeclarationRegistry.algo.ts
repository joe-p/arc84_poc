import { Contract } from '@algorandfoundation/tealscript';

export type ARC11550Id = uint64;

export type AddressAsset = {
  addr: Address;
  app: AppID;
  id: ARC11550Id;
};

export class DeclarationRegistry extends Contract {
  /** ARC11550 declaration for a given user. Wallets & apps SHOULD show these assets to users */
  declarations = BoxMap<AddressAsset, bytes<0>>();

  /** Requests for ARC11550 declarations for a given users. Wallets & apps MAY show these assets to users, but SHOULD be separated from
   * declarations */
  requests = BoxMap<AddressAsset, bytes<0>>({ prefix: 'r' });

  /** Approval apps determine if a declaration/request addition or removal is allowed. This allows various use cases such as declaration delegation or only
   * allowing requests from trusted accounts */
  approvalApps = BoxMap<AddressAsset, AppID>({ prefix: 'a' });

  /** Declare the given ARC11550 asset for the given address. If an approval app has been defined for the address, that app is called to ensure the
   * declaration is allowed. If an approval app has not be defined, the transaction sender must match the declaration address */
  declare(addrAsset: AddressAsset): void {
    if (this.declarations(addrAsset).exists) {
      return;
    }

    if (this.approvalApps(addrAsset).exists) {
      // TODO: send method call to approval app
    } else {
      assert(this.txn.sender == addrAsset.addr);
    }

    this.declarations(addrAsset).value = '' as bytes<0>;
  }

  /** Declare the given ARC11550 asset for the given address. If an approval app has been added for the user, that app is called to ensure the
   * declaration is allowed */
  request(addrAsset: AddressAsset): void {
    if (this.requests(addrAsset).exists) {
      return;
    }

    if (this.approvalApps(addrAsset).exists) {
      // TODO: send method call to approval app
    }

    this.requests(addrAsset).value = '' as bytes<0>;
  }

  removeDeclaration(addrAsset: AddressAsset): void {
    if (this.approvalApps(addrAsset).exists) {
      // TODO: send method call to approval app
    } else {
      assert(this.txn.sender == addrAsset.addr);
    }

    this.declarations(addrAsset).delete();
  }

  removeRequest(addrAsset: AddressAsset): void {
    if (this.approvalApps(addrAsset).exists) {
      // TODO: send method call to approval app
    } else {
      assert(this.txn.sender == addrAsset.addr);
    }

    this.requests(addrAsset).delete();
  }

  isRequested(addrAsset: AddressAsset): boolean {
    return this.requests(addrAsset).exists;
  }

  isDeclared(addrAsset: AddressAsset): boolean {
    return this.requests(addrAsset).exists;
  }
}
