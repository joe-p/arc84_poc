import { Contract } from '@algorandfoundation/tealscript';
import { Transfer, ARC84Data, CollectionId } from './ARC84Data.algo';
import { ARC84Transfer } from './ARC84Transfer.algo';

export type Arc84Id = {
  id: uint64;
  dataApp: AppID;
};

export type AsaAndAddr = {
  asa: AssetID;
  address: Address;
};

export class ARC84Bridge extends Contract {
  asaToArc84Map = BoxMap<AssetID, Arc84Id>({ prefix: 'asa' });

  arc84ToAsaMap = BoxMap<Arc84Id, AssetID>({ prefix: 'app' });

  /** The data app to use when creating new tokens */
  dataApp = GlobalStateKey<AppID>();

  /** The collection to mint to when using a new token */
  collection = GlobalStateKey<CollectionId>();

  /** The amount of the given asset the given address has available to claim */
  withdrawAmounts = BoxMap<AsaAndAddr, uint64>();

  createApplication(dataApp: AppID) {
    this.dataApp.value = dataApp;
    this.collection.value = sendMethodCall<typeof ARC84Data.prototype.arc84_newCollection>({
      applicationID: dataApp,
      methodArgs: [this.app.address, btoi(hex('0xFFFFFFFFFFFFFFFF'))],
    });
  }

  optInToAsa(asa: AssetID) {
    sendAssetTransfer({
      xferAsset: asa,
      assetAmount: 0,
      assetReceiver: this.app.address,
    });
  }

  asaToArc84(axfer: AssetTransferTxn, receiver: Address): Arc84Id {
    verifyAssetTransferTxn(axfer, {
      assetReceiver: this.app.address,
    });

    const asa = axfer.xferAsset;

    // If there isn't already a token for this ASA, create it
    if (!this.asaToArc84Map(axfer.xferAsset).exists) {
      const id = sendMethodCall<typeof ARC84Data.prototype.arc84_mint>({
        applicationID: this.dataApp.value,
        methodArgs: [
          this.collection.value,
          {
            total: asa.total,
            decimals: asa.decimals,
            manager: this.app.address,
            name: asa.name as bytes<32>,
            symbol: asa.unitName as bytes<8>,
            transferHookApp: AppID.zeroIndex,
          },
        ],
      });

      const appAndId: Arc84Id = { dataApp: this.dataApp.value, id: id };
      this.asaToArc84Map(asa).value = appAndId;
      this.arc84ToAsaMap(appAndId).value = asa;
    }

    const arc84 = this.asaToArc84Map(asa).value;

    const xferApp = sendMethodCall<typeof ARC84Data.prototype.arc84_transferApp>({
      applicationID: arc84.dataApp,
    });

    // TODO: Get transfer app instead of using data app
    sendMethodCall<typeof ARC84Transfer.prototype.arc84_transfer>({
      applicationID: xferApp,
      methodArgs: [
        arc84.dataApp,
        [{ tokenId: arc84.id, amount: axfer.assetAmount, from: this.app.address, to: receiver }],
      ],
    });

    return arc84;
  }

  arc84ToAsa(xferCall: AppCallTxn, xferIndex: uint64, receiver: Address): AssetID {
    const xfers: Transfer[] = castBytes<Transfer[]>(extract3(xferCall.applicationArgs[2], 2, 0));
    const xfer = xfers[xferIndex];
    assert(xfer.to === this.app.address);

    const dataApp = AppID.fromUint64(btoi(xferCall.applicationArgs[1]));

    // Ensure the app used for the transfer is the actual transfer app for the token
    assert(
      xferCall.applicationID == sendMethodCall<typeof ARC84Data.prototype.arc84_transferApp>({ applicationID: dataApp })
    );

    const arc84: Arc84Id = { dataApp: dataApp, id: xfer.tokenId };

    if (!this.arc84ToAsaMap(arc84).exists) {
      const params = sendMethodCall<typeof ARC84Data.prototype.arc84_params>({
        applicationID: arc84.dataApp,
        methodArgs: [xfer.tokenId],
      });

      sendAssetCreation({
        configAssetTotal: params.total as uint64,
        configAssetDecimals: params.decimals as uint64,
        configAssetName: params.name as bytes,
        configAssetUnitName: params.symbol as bytes,
        configAssetReserve: this.app.address,
      });

      const asa = this.itxn.createdAssetID;
      this.arc84ToAsaMap(arc84).value = asa;
      this.asaToArc84Map(asa).value = arc84;
    }

    const asa = this.arc84ToAsaMap(arc84).value;

    if (!receiver.isOptedInToAsset(asa)) {
      const key: AsaAndAddr = { asa: asa, address: receiver };
      if (!this.withdrawAmounts(key).exists) this.withdrawAmounts(key).create();

      this.withdrawAmounts(key).value += xfer.amount;
    } else {
      sendAssetTransfer({ xferAsset: asa, assetReceiver: receiver, assetAmount: xfer.amount });
    }

    return asa;
  }

  withdrawAsa(asa: AssetID, withdrawalFor: Address) {
    const key: AsaAndAddr = { asa: asa, address: withdrawalFor };
    sendAssetTransfer({ xferAsset: asa, assetReceiver: withdrawalFor, assetAmount: this.withdrawAmounts(key).value });
    this.withdrawAmounts(key).delete();

    // TODO: Send back MBR
  }

  // TODO: arc84ToAsa with approval
}
