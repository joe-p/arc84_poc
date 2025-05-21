import { Contract } from '@algorandfoundation/tealscript';
import { Transfer, ARC11550Data, CollectionId } from './ARC11550Data.algo';
import { ARC11550Transfer } from './ARC11550Transfer.algo';

export type Arc11550Id = {
  id: uint64;
  dataApp: AppID;
};

export type AsaAndAddr = {
  asa: AssetID;
  address: Address;
};

export class ARC11550Bridge extends Contract {
  asaToArc11550Map = BoxMap<AssetID, Arc11550Id>({ prefix: 'asa' });
  arc11550ToAsaMap = BoxMap<Arc11550Id, AssetID>({ prefix: 'app' });

  /** The data app to use when creating new tokens */
  dataApp = GlobalStateKey<AppID>();

  /** The collection to mint to when using a new token */
  collection = GlobalStateKey<CollectionId>();

  /** The amount of the given asset the given address has available to claim */
  withdrawAmounts = BoxMap<AsaAndAddr, uint64>();

  createApplication(dataApp: AppID) {
    this.dataApp.value = dataApp;
  }

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
      const id = sendMethodCall<typeof ARC11550Data.prototype.arc11550_mint>({
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

      const appAndId: Arc11550Id = { dataApp: this.dataApp.value, id: id };
      this.asaToArc11550Map(asa).value = appAndId;
      this.arc11550ToAsaMap(appAndId).value = asa;
    }

    const arc11550 = this.asaToArc11550Map(asa).value;

    sendMethodCall<typeof ARC11550Transfer.prototype.arc11550_transfer>({
      applicationID: arc11550.dataApp,
      methodArgs: [
        arc11550.dataApp,
        [{ tokenId: arc11550.id, amount: axfer.assetAmount, from: this.app.address, to: receiver }],
      ],
    });

    return arc11550;
  }

  arc11550ToAsa(xferCall: AppCallTxn, xferIndex: uint64, receiver: Address): AssetID {
    const xfers: Transfer[] = castBytes<Transfer[]>(extract3(xferCall.applicationArgs[2], 2, 0));
    const xfer = xfers[xferIndex];
    assert(xfer.to === this.app.address);

    const dataApp = AppID.fromUint64(btoi(xferCall.applicationArgs[1]));

    // Ensure the app used for the transfer is the actual transfer app for the token
    assert(
      xferCall.applicationID ==
        sendMethodCall<typeof ARC11550Data.prototype.arc11550_transferApp>({ applicationID: dataApp })
    );

    const arc11550: Arc11550Id = { dataApp: dataApp, id: xfer.tokenId };

    if (!this.arc11550ToAsaMap(arc11550).exists) {
      const params = sendMethodCall<typeof ARC11550Data.prototype.arc11550_params>({
        applicationID: arc11550.dataApp,
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
      this.arc11550ToAsaMap(arc11550).value = asa;
      this.asaToArc11550Map(asa).value = arc11550;
    }

    const asa = this.arc11550ToAsaMap(arc11550).value;

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

  // TODO: arc11550ToAsa with approval
}
