import { Contract } from '@algorandfoundation/tealscript';
import { ARC200 } from './ARC200.algo';

export type AddressApp = {
  addr: Address;
  app: AppID;
};

export type ARC200Params = {
  total: uint256;
  decimals: uint8;
  name: bytes<32>;
  symbol: bytes<8>;
};

export class ARC200Bridge extends Contract {
  asaToArc200Map = BoxMap<AssetID, AppID>({ prefix: 'asa' });

  arc200ToAsaMap = BoxMap<AppID, AssetID>({ prefix: 'app' });

  optInToAsa(asa: AssetID) {
    sendAssetTransfer({
      xferAsset: asa,
      assetAmount: 0,
      assetReceiver: this.app.address,
    });
  }

  asaToArc200(axfer: AssetTransferTxn, receiver: Address): AppID {
    verifyAssetTransferTxn(axfer, {
      assetReceiver: this.app.address,
    });

    const asa = axfer.xferAsset;

    assert(asa.clawback === Address.zeroAddress);

    // If there isn't already an app for this ASA, create it
    if (!this.asaToArc200Map(axfer.xferAsset).exists) {
      sendMethodCall<typeof ARC200.prototype.createApplication>({
        methodArgs: [
          asa.name as bytes<32>,
          asa.unitName as bytes<8>,
          // PROBLEM: we need to go from uint64 to uint8
          asa.decimals as uint8,
          asa.total as uint256,
        ],
      });

      const app = this.itxn.createdApplicationID;

      this.asaToArc200Map(asa).value = app;
      this.arc200ToAsaMap(app).value = asa;
    }

    const arc200App = this.asaToArc200Map(asa).value;

    const transferSucceeded = sendMethodCall<typeof ARC200.prototype.arc200_transfer>({
      applicationID: arc200App,
      methodArgs: [receiver, axfer.assetAmount as uint256],
    });

    assert(transferSucceeded);

    return arc200App;
  }

  // NOTE: Would've been nice to have this in ARC200
  private getArc200Params(app: AppID): ARC200Params {
    return {
      total: sendMethodCall<typeof ARC200.prototype.arc200_totalSupply>({ applicationID: app }),
      name: sendMethodCall<typeof ARC200.prototype.arc200_name>({ applicationID: app }),
      symbol: sendMethodCall<typeof ARC200.prototype.arc200_symbol>({ applicationID: app }),
      decimals: sendMethodCall<typeof ARC200.prototype.arc200_decimals>({ applicationID: app }),
    };
  }

  arc200ToAsa(app: AppID, amount: uint64, receiver: Address): AssetID {
    if (!this.arc200ToAsaMap(app).exists) {
      const params = this.getArc200Params(app);
      sendAssetCreation({
        configAssetTotal: params.total as uint64,
        configAssetDecimals: params.decimals as uint64,
        configAssetName: params.name as bytes,
        configAssetUnitName: params.symbol as bytes,
        configAssetReserve: this.app.address,
      });

      const asa = this.itxn.createdAssetID;
      this.arc200ToAsaMap(app).value = asa;
      this.asaToArc200Map(asa).value = app;
    }

    const asa = this.arc200ToAsaMap(app).value;

    // This bridge app should be approved
    const transferSucceeded = sendMethodCall<typeof ARC200.prototype.arc200_transferFrom>({
      applicationID: app,
      methodArgs: [this.txn.sender, this.app.address, amount as uint256],
    });

    assert(transferSucceeded);

    sendAssetTransfer({ xferAsset: asa, assetReceiver: receiver, assetAmount: amount });

    return asa;
  }
}
