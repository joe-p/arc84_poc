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
  declare(addrAsset: AddressAsset): boolean {
    if (this.declarations(addrAsset).exists) {
      return true;
    }

    let approved: boolean;
    if (this.approvalApps(addrAsset).exists) {
      approved = sendMethodCall<typeof ApprovalApp.prototype.approveDeclaration>({
        applicationID: this.approvalApps(addrAsset).value,
        methodArgs: [this.txn.sender, addrAsset],
      });
    } else {
      approved = this.txn.sender == addrAsset.addr;
    }

    if (!approved) return false;

    this.declarations(addrAsset).value = '' as bytes<0>;

    return true;
  }

  /** Declare the given ARC11550 asset for the given address. If an approval app has been added for the user, that app is called to ensure the
   * declaration is allowed */
  request(addrAsset: AddressAsset): boolean {
    if (this.requests(addrAsset).exists) {
      return true;
    }

    if (this.approvalApps(addrAsset).exists) {
      const approved = sendMethodCall<typeof ApprovalApp.prototype.approveRequest>({
        applicationID: this.approvalApps(addrAsset).value,
        methodArgs: [this.txn.sender, addrAsset],
      });

      if (!approved) return false;
    }

    this.requests(addrAsset).value = '' as bytes<0>;

    return true;
  }

  removeDeclaration(addrAsset: AddressAsset): boolean {
    if (!this.declarations(addrAsset).exists) {
      return true;
    }

    let approved: boolean;

    if (this.approvalApps(addrAsset).exists) {
      approved = sendMethodCall<typeof ApprovalApp.prototype.approveDeclarationRemoval>({
        applicationID: this.approvalApps(addrAsset).value,
        methodArgs: [this.txn.sender, addrAsset],
      });
    } else {
      approved = this.txn.sender == addrAsset.addr;
    }

    if (!approved) return false;
    this.declarations(addrAsset).delete();
    return true;
  }

  removeRequest(addrAsset: AddressAsset): boolean {
    if (!this.requests(addrAsset).exists) {
      return true;
    }
    let approved: boolean;

    if (this.approvalApps(addrAsset).exists) {
      approved = sendMethodCall<typeof ApprovalApp.prototype.approveRequestRemoval>({
        applicationID: this.approvalApps(addrAsset).value,
        methodArgs: [this.txn.sender, addrAsset],
      });
    } else {
      approved = this.txn.sender == addrAsset.addr;
    }

    if (!approved) return false;
    this.requests(addrAsset).delete();
    return true;
  }

  isRequested(addrAsset: AddressAsset): boolean {
    return this.requests(addrAsset).exists;
  }

  isDeclared(addrAsset: AddressAsset): boolean {
    return this.requests(addrAsset).exists;
  }
}

class ApprovalApp extends Contract {
  approveRequest(sender: Address, addrAsset: AddressAsset): boolean {
    return true;
  }

  approveRequestRemoval(sender: Address, addrAsset: AddressAsset): boolean {
    return true;
  }

  approveDeclaration(sender: Address, addrAsset: AddressAsset): boolean {
    return sender === addrAsset.addr;
  }

  approveDeclarationRemoval(sender: Address, addrAsset: AddressAsset): boolean {
    return sender === addrAsset.addr;
  }
}
