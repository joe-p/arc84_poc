import { Contract } from '@algorandfoundation/tealscript';

export type AddressApp = {
  addr: Address;
  app: AppID;
};

// ABA = App-Based Asset

export class DeclarationRegistry extends Contract {
  /** ABA declaration for a given user. Wallets & apps SHOULD show these assets to users */
  declarations = BoxMap<AddressApp, bytes<0>>();

  /** Requests for ABA declarations for a given users. Wallets & apps MAY show these assets to users, but should be separated from
   * declarations */
  requests = BoxMap<AddressApp, bytes<0>>({ prefix: 'r' });

  /** Approval apps determine if a declaration/request addition or removal is allowed. This allows various use cases such as declaration delegation or only
   * allowing requests from trusted accounts */
  approvalApps = BoxMap<AddressApp, AppID>({ prefix: 'a' });

  /** Declare the given ABA asset for the given address. If an approval app has been defined for the address, that app is called to ensure the
   * declaration is allowed. If an approval app has not be defined, the transaction sender must match the declaration address */
  declare(addrApp: AddressApp): void {
    if (this.declarations(addrApp).exists) {
      return;
    }

    if (this.approvalApps(addrApp).exists) {
      // TODO: send method call to approval app
    } else {
      assert(this.txn.sender == addrApp.addr);
    }

    this.declarations(addrApp).value = '' as bytes<0>;
  }

  /** Declare the given ABA for the given address. If an approval app has been added for the user, that app is called to ensure the
   * declaration is allowed */
  request(addrApp: AddressApp): void {
    if (this.requests(addrApp).exists) {
      return;
    }

    if (this.approvalApps(addrApp).exists) {
      // TODO: send method call to approval app
    }

    this.requests(addrApp).value = '' as bytes<0>;
  }

  removeDeclaration(addrApp: AddressApp): void {
    if (this.approvalApps(addrApp).exists) {
      // TODO: send method call to approval app
    } else {
      assert(this.txn.sender == addrApp.addr);
    }

    this.declarations(addrApp).delete();
  }

  removeRequest(addrApp: AddressApp): void {
    if (this.approvalApps(addrApp).exists) {
      // TODO: send method call to approval app
    } else {
      assert(this.txn.sender == addrApp.addr);
    }

    this.requests(addrApp).delete();
  }

  isRequested(addrApp: AddressApp): boolean {
    return this.requests(addrApp).exists;
  }

  isDeclared(addrApp: AddressApp): boolean {
    return this.requests(addrApp).exists;
  }
}
