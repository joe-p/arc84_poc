import { Contract } from '@algorandfoundation/tealscript';
import { ARC11550, Transfer } from './ARC11550.algo';
import { Approval } from './ARC200.algo';

export type Arc11550Id = {
  id: uint64;
  app: AppID;
};

export class ARC11550Bridge extends Contract {
  asaToArc11550Map = BoxMap<AssetID, Arc11550Id>({ prefix: 'asa' });
  arc11550ToAsaMap = BoxMap<Arc11550Id, AssetID>({ prefix: 'app' });

  optInToAsa(asa: AssetID) {
    sendAssetTransfer({
      xferAsset: asa,
      assetAmount: 0,
      assetReceiver: this.app.address,
    });
  }

  asaToArc11550(axfer: AssetTransferTxn, receiver: Address): Arc11550Id {
    verifyAssetTransferTxn(axfer, {
      assetReceiver: this.app.address,
    });

    const asa = axfer.xferAsset;

    assert(asa.clawback === Address.zeroAddress);

    // If there isn't already an app for this ASA, create it
    if (!this.asaToArc11550Map(axfer.xferAsset).exists) {
      sendMethodCall<typeof ARC11550.prototype.createApplication>({
        methodArgs: [AppID.fromUint64(0), 1],
      });

      const app = this.itxn.createdApplicationID;

      const id = sendMethodCall<typeof ARC11550.prototype.arc11550_mint>({
        applicationID: app,
        methodArgs: [
          {
            total: asa.total,
            decimals: asa.decimals,
            manager: this.app.address,
            name: asa.name as bytes<32>,
            symbol: asa.unitName as bytes<8>,
          },
        ],
      });

      const appAndId: Arc11550Id = { app: app, id: id };
      this.asaToArc11550Map(asa).value = appAndId;
      this.arc11550ToAsaMap(appAndId).value = asa;
    }

    const arc11550 = this.asaToArc11550Map(asa).value;

    sendMethodCall<typeof ARC11550.prototype.arc11550_transfer>({
      applicationID: arc11550.app,
      methodArgs: [[{ id: arc11550.id, amount: axfer.assetAmount, from: this.app.address, to: receiver }]],
    });

    return arc11550;
  }

  arc11550ToAsa(xferCall: AppCallTxn, xferIndex: uint64, receiver: Address): AssetID {
    const xfers: Transfer[] = castBytes<Transfer[]>(xferCall.applicationArgs[1]);
    const xfer = xfers[xferIndex];

    const arc11550: Arc11550Id = { app: xferCall.applicationID, id: xfer.id };

    if (!this.arc11550ToAsaMap(arc11550).exists) {
      const params = sendMethodCall<typeof ARC11550.prototype.arc11550_params>({
        applicationID: arc11550.app,
        methodArgs: [xfer.id],
      });

      sendAssetCreation({
        configAssetTotal: params.total as uint64,
        configAssetDecimals: params.decimals as uint64,
        configAssetName: params.name as bytes,
        configAssetUnitName: params.symbol as bytes,
        configAssetReserve: this.app.address,
      });

      const asa = this.itxn.createdAssetID;
      this.arc11550ToAsaMap(arc11550).value = asa;
      this.asaToArc11550Map(asa).value = arc11550;
    }

    const asa = this.arc11550ToAsaMap(arc11550).value;

    sendAssetTransfer({ xferAsset: asa, assetReceiver: receiver, assetAmount: xfer.amount });

    return asa;
  }

  // TODO: arc11550ToAsa with approval
}
