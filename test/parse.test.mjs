import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, wordsToNumbers, describe } from '../server/parse.mjs';

const cases = [
  ['buy 0.01 eth', { kind: 'hl_order', side: 'buy', size: '0.01', coin: 'ETH' }],
  ['Long 0.01 ETH.', { kind: 'hl_order', side: 'buy', size: '0.01', coin: 'ETH' }],
  ['short zero point zero two ether', { kind: 'hl_order', side: 'sell', size: '0.02', coin: 'ETH' }],
  ['sell .5 eth', { kind: 'hl_order', side: 'sell', size: '0.5', coin: 'ETH' }],
  ['Close my ETH position.', { kind: 'hl_close', coin: 'ETH' }],
  ['close', { kind: 'hl_close', coin: 'ETH' }],
  ['Supply 50 USDC', { kind: 'aave_supply', amount: '50' }],
  ['deposit fifty dollars', { kind: 'aave_supply', amount: '50' }],
  ['Supply $1,250 to Aave', { kind: 'aave_supply', amount: '1250' }],
  ['withdraw twenty usdc', { kind: 'aave_withdraw', amount: '20' }],
  ['Withdraw everything.', { kind: 'aave_withdraw', amount: 'all' }],
  ['swap 10 usdc to eth', { kind: 'swap', amount: '10', from: 'USDC', to: 'ETH' }],
  ['Swap 0.001 ETH for USDC.', { kind: 'swap', amount: '0.001', from: 'ETH', to: 'USDC' }],
  ['convert a hundred dollars into ethereum', { kind: 'swap', amount: '100', from: 'USDC', to: 'ETH' }],
  ['bet 10 dollars on yes', { kind: 'pm_bet', amount: '10', outcome: 'yes', about: [] }],
  ['Bet $25 on no for Nvidia.', { kind: 'pm_bet', amount: '25', outcome: 'no', about: ['nvidia'] }],
  ['bet ten bucks on the yes', { kind: 'pm_bet', amount: '10', outcome: 'yes', about: [] }],
  ['bet 0.1 eth on yes', null],
  ['bet on yes', null],
  ['cash out', { kind: 'pm_close', about: [] }],
  ['close my bet on nvidia', { kind: 'pm_close', about: ['nvidia'] }],
  ['sell my bet', { kind: 'pm_close', about: [] }],
  ['move 40 usdc to perps', { kind: 'hl_transfer', amount: '40', toPerp: true }],
  ['Transfer twenty dollars to spot.', { kind: 'hl_transfer', amount: '20', toPerp: false }],
  ['move everything to perks', { kind: 'hl_transfer', amount: 'all', toPerp: true }],
  ['move 10 usdc from spot to perps', { kind: 'hl_transfer', amount: '10', toPerp: true }],
  ['move 0.1 eth to perps', null],
  ['move 0.5 hype to hyperliquid', { kind: 'hype_move', amount: '0.5', toCore: true }],
  ['Send one HYPE to Hyper EVM.', { kind: 'hype_move', amount: '1', toCore: false }],
  ['move 2 hype to hyper liquid', { kind: 'hype_move', amount: '2', toCore: true }],
  ['move hype to evm', null],
  ['buy $50 of eth', { kind: 'hl_order', side: 'buy', usd: '50', coin: 'ETH' }],
  ['Long ETH with 100 dollars at 5x.', { kind: 'hl_order', side: 'buy', usd: '100', coin: 'ETH', leverage: 5 }],
  ['short 0.01 btc 2x', { kind: 'hl_order', side: 'sell', size: '0.01', coin: 'BTC', leverage: 2 }],
  ['buy fifty dollars of bitcoin with five times leverage', { kind: 'hl_order', side: 'buy', usd: '50', coin: 'BTC', leverage: 5 }],
  ['buy 0.01 eth leverage 3', { kind: 'hl_order', side: 'buy', size: '0.01', coin: 'ETH', leverage: 3 }],
  ['close half my eth', { kind: 'hl_close', coin: 'ETH', fraction: 0.5 }],
  ['Close 25% of BTC.', { kind: 'hl_close', coin: 'BTC', fraction: 0.25 }],
  ['close 100 percent eth', { kind: 'hl_close', coin: 'ETH' }],
  ['set eth leverage to 5x', { kind: 'hl_leverage', coin: 'ETH', leverage: 5 }],
  ['show my history', { kind: 'history' }],
  ['What can I say?', { kind: 'help' }],
  ['help', { kind: 'help' }],
  ['Yes.', { kind: 'yes' }],
  ['cancel', { kind: 'no' }],
  ["How am I doing?", { kind: 'status' }],
  ['buy 10 usdc', null],
  ['swap eth to eth', null],
  ['what is the weather', null],
];

for (const [text, want] of cases) {
  test(`parse: ${text}`, () => assert.deepEqual(parse(text), want));
}

test('numbers in words', () => {
  assert.deepEqual(wordsToNumbers('two hundred and fifty'.split(' ')), ['250']);
  assert.deepEqual(wordsToNumbers('one thousand five hundred'.split(' ')), ['1500']);
  assert.deepEqual(wordsToNumbers('zero point zero one eth'.split(' ')), ['0.01', 'eth']);
  assert.deepEqual(wordsToNumbers('3 point 5'.split(' ')), ['3.5']);
  assert.deepEqual(wordsToNumbers('a point'.split(' ')), ['a', 'point']);
});

test('describe fits the glasses', () => {
  for (const [text] of cases) {
    const i = parse(text);
    if (i && !['yes', 'no', 'status'].includes(i.kind)) assert.ok(describe(i).length <= 32, describe(i));
  }
});
