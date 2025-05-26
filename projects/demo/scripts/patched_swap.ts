#!/usr/bin/env bun

/* eslint-disable no-console */
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { monkeyPatchTinymanV2Swap } from '../src/utils/autoBridge'
import 'dotenv/config'
import { attemptSwap } from './attempt_swap'

async function patchedSwap() {
  const algod = AlgorandClient.testNet().client.algod
  monkeyPatchTinymanV2Swap(algod, BigInt(process.env.BRIDGE_APP_ID!))
  await attemptSwap()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  patchedSwap()
}
