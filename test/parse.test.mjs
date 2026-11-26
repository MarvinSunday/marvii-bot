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
