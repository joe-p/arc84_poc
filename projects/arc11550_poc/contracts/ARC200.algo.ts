import { Contract } from '@algorandfoundation/tealscript';

export type Approval = {
  owner: Address;
  spender: Address;
};

export class ARC200 extends Contract {
  name = GlobalStateKey<bytes<32>>();

  symbol = GlobalStateKey<bytes<8>>();

  decimals = GlobalStateKey<uint8>();

  totalSupply = GlobalStateKey<uint256>();

  balances = BoxMap<Address, uint256>();

  allowances = BoxMap<Approval, uint256>();

  arc200_Transfer = new EventLogger<{
    from: Address;
    to: Address;
    value: uint256;
  }>();

  arc200_Approval = new EventLogger<{
    owner: Address;
    spender: Address;
    value: uint256;
  }>();

  createApplication(name: bytes<32>, symbol: bytes<8>, decimals: uint8, total: uint256): void {
    this.name.value = name;
    this.symbol.value = symbol;
    this.decimals.value = decimals;
    this.totalSupply.value = total;
    this.balances(this.txn.sender).value = total;
  }

  arc200_name(): bytes<32> {
    return this.name.value;
  }

  arc200_symbol(): bytes<8> {
    return this.symbol.value;
  }

  arc200_decimals(): uint8 {
    return this.decimals.value;
  }

  arc200_totalSupply(): uint256 {
    return this.totalSupply.value;
  }

  arc200_balanceOf(account: Address): uint256 {
    return this.balances(account).value;
  }

  private transfer(from: Address, to: Address, amount: uint256): boolean {
    this.balances(from).value -= amount;
    this.balances(to).value += amount;
    this.arc200_Transfer.log({ from: from, to: to, value: amount });

    return true;
  }

  arc200_transferFrom(from: Address, to: Address, amount: uint256): boolean {
    const approval: Approval = { owner: from, spender: this.txn.sender };

    assert(this.allowances(approval).value >= amount);
    this.allowances(approval).value -= amount;

    return this.transfer(from, to, amount);
  }

  arc200_transfer(to: Address, amount: uint256): boolean {
    return this.transfer(this.txn.sender, to, amount);
  }

  arc200_approve(spender: Address, value: uint256): boolean {
    const approval: Approval = { owner: this.txn.sender, spender: spender };
    if (!this.allowances(approval).exists) {
      this.allowances(approval).value = value;
    } else {
      this.allowances(approval).value += value;
    }

    return true;
  }

  arc200_allowance(owner: Address, sender: Address): uint256 {
    return this.allowances({ owner: owner, spender: sender }).value;
  }
}
