import { Contract } from '@algorandfoundation/tealscript';

export type AddressApp = {
  addr: Address;
  app: AppID;
};

// ABA = App-Based Asset

export class ARC200Bridge extends Contract {}
