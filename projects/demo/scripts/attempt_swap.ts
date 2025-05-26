#!/usr/bin/env bun

/* eslint-disable no-console */
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Swap, type SignerTransaction, poolUtils, SupportedNetwork, SwapType } from '@tinymanorg/tinyman-js-sdk'
import algosdk, { type Algodv2 } from 'algosdk'
import { setup, USDC_ASA_ID } from './setup'
import 'dotenv/config'
import { getBalancesWithBrigedToken } from '../src/utils/autoBridge'

function signerWithSecretKey(account: algosdk.Account) {
  return function (txGroups: SignerTransaction[][]): Promise<Uint8Array[]> {
    // Filter out transactions that don't need to be signed by the account
    const txnsToBeSigned = txGroups.flatMap((txGroup) => txGroup.filter((item) => item.signers?.includes(account.addr.toString())))
    // Sign all transactions that need to be signed by the account
    const signedTxns: Uint8Array[] = txnsToBeSigned.map(({ txn }) => txn.signTxn(account.sk))

    // We wrap this with a Promise since SDK's initiatorSigner expects a Promise
    return new Promise((resolve) => {
      resolve(signedTxns)
    })
  }
}

export async function fixedInputSwapWithoutSwapRouter({
  algodClient,
  account,
  asset_1,
  asset_2,
  amount,
}: {
  algodClient: Algodv2
  account: algosdk.Account
  asset_1: bigint
  asset_2: bigint
  amount: bigint
}) {
  const initiatorAddr = account.addr.toString()
  const pool = await poolUtils.v2.getPoolInfo({
    network: 'testnet' as SupportedNetwork,
    client: algodClient,
    asset1ID: Number(asset_1),
    asset2ID: Number(asset_2),
  })

  /**
   * This example uses only v2 quote. Similarly, we can use
   * Swap.getQuote method, which will return the best quote (highest rate)
   * after checking both v1 and v2, without using the swap router
   */

  const fixedInputSwapQuote = await Swap.v2.getQuote({
    type: SwapType.FixedInput,
    pool,
    amount,
    assetIn: { id: pool.asset1ID, decimals: 6 },
    assetOut: { id: pool.asset2ID, decimals: 6 },
    slippage: 0.05,
    network: 'testnet',
  })

  const fixedInputSwapTxns = await Swap.v2.generateTxns({
    client: algodClient,
    network: 'testnet',
    quote: fixedInputSwapQuote,
    swapType: SwapType.FixedInput,
    slippage: 0.05,
    initiatorAddr,
  })

  const signedTxns = await Swap.v2.signTxns({
    txGroup: fixedInputSwapTxns,
    initiatorSigner: signerWithSecretKey(account),
  })

  const swapExecutionResponse = await Swap.v2.execute({
    quote: fixedInputSwapQuote,
    client: algodClient,
    signedTxns,
    txGroup: fixedInputSwapTxns,
  })

  console.log('✅ Fixed Input Swap with disabled Swap Router executed successfully!')
  console.log({ txnID: swapExecutionResponse.txnID })
}

export async function attemptSwap() {
  await setup()
  const algorand = AlgorandClient.testNet()
  const demoAccount = (await algorand.account.fromEnvironment('DEMO')).account

  try {
    await fixedInputSwapWithoutSwapRouter({
      algodClient: algorand.client.algod,
      account: demoAccount,
      asset_1: USDC_ASA_ID,
      asset_2: 0n,
      amount: 10_000_000n,
    })
  } catch (e) {
    console.error(e)
    console.error('The above error occurred because we are trying to swap 10 USDC, but only have 5 USDC')
    console.log(await getBalancesWithBrigedToken(algorand.client.algod, demoAccount.addr, USDC_ASA_ID, BigInt(process.env.BRIDGE_APP_ID!)))
    process.exit(1)
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  attemptSwap()
}
