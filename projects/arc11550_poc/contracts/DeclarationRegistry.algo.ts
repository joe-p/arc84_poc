import { Contract } from '@algorandfoundation/tealscript';

export type ARC11550Id = uint64;

export type AddressToken = {
  addr: Address;
  app: AppID;
  id: ARC11550Id;
};

export class DeclarationRegistry extends Contract {
  /** ARC11550 declaration for a given user. Wallets & apps SHOULD show these tokens to users */
  declarations = BoxMap<AddressToken, bytes<0>>();

  /** Requests for ARC11550 declarations for a given users. Wallets & apps MAY show these tokens to users, but SHOULD be separated from
   * declarations */
  requests = BoxMap<AddressToken, bytes<0>>({ prefix: 'r' });

  /** Approval apps determine if a declaration/request addition or removal is allowed. This allows various use cases such as declaration delegation or only
   * allowing requests from trusted accounts */
  approvalApps = BoxMap<AddressToken, AppID>({ prefix: 'a' });

  /** Declare the given ARC11550 token for the given address. If an approval app has been defined for the address, that app is called to ensure the
   * declaration is allowed. If an approval app has not be defined, the transaction sender must match the declaration address */
  declare(addrToken: AddressToken): boolean {
    if (this.declarations(addrToken).exists) {
      return true;
    }

    let approved: boolean;
    if (this.approvalApps(addrToken).exists) {
      approved = sendMethodCall<typeof ApprovalApp.prototype.approveDeclaration>({
        applicationID: this.approvalApps(addrToken).value,
        methodArgs: [this.txn.sender, addrToken],
      });
    } else {
      approved = this.txn.sender == addrToken.addr;
    }

    if (!approved) return false;

    this.declarations(addrToken).value = '' as bytes<0>;

    return true;
  }

  /** Declare the given ARC11550 token for the given address. If an approval app has been added for the user, that app is called to ensure the
   * declaration is allowed */
  request(addrToken: AddressToken): boolean {
    if (this.requests(addrToken).exists) {
      return true;
    }

    if (this.approvalApps(addrToken).exists) {
      const approved = sendMethodCall<typeof ApprovalApp.prototype.approveRequest>({
        applicationID: this.approvalApps(addrToken).value,
        methodArgs: [this.txn.sender, addrToken],
      });

      if (!approved) return false;
    }

    this.requests(addrToken).value = '' as bytes<0>;

    return true;
  }

  removeDeclaration(addrToken: AddressToken): boolean {
    if (!this.declarations(addrToken).exists) {
      return true;
    }

    let approved: boolean;

    if (this.approvalApps(addrToken).exists) {
      approved = sendMethodCall<typeof ApprovalApp.prototype.approveDeclarationRemoval>({
        applicationID: this.approvalApps(addrToken).value,
        methodArgs: [this.txn.sender, addrToken],
      });
    } else {
      approved = this.txn.sender == addrToken.addr;
    }

    if (!approved) return false;
    this.declarations(addrToken).delete();
    return true;
  }

  removeRequest(addrToken: AddressToken): boolean {
    if (!this.requests(addrToken).exists) {
      return true;
    }
    let approved: boolean;

    if (this.approvalApps(addrToken).exists) {
      approved = sendMethodCall<typeof ApprovalApp.prototype.approveRequestRemoval>({
        applicationID: this.approvalApps(addrToken).value,
        methodArgs: [this.txn.sender, addrToken],
      });
    } else {
      approved = this.txn.sender == addrToken.addr;
    }

    if (!approved) return false;
    this.requests(addrToken).delete();
    return true;
  }

  isRequested(addrToken: AddressToken): boolean {
    return this.requests(addrToken).exists;
  }

  isDeclared(addrToken: AddressToken): boolean {
    return this.requests(addrToken).exists;
  }
}

class ApprovalApp extends Contract {
  approveRequest(sender: Address, addrToken: AddressToken): boolean {
    return true;
  }

  approveRequestRemoval(sender: Address, addrToken: AddressToken): boolean {
    return true;
  }

  approveDeclaration(sender: Address, addrToken: AddressToken): boolean {
    return sender === addrToken.addr;
  }

  approveDeclarationRemoval(sender: Address, addrToken: AddressToken): boolean {
    return sender === addrToken.addr;
  }
}
