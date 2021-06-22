// LICENSE: Business Source License 1.1 see LICENSE.txt

// We import Chai to use its asserting functions here.
const { expect } = require("chai");

// Adapted from https://medium.com/coinmonks/testing-time-dependent-logic-in-ethereum-smart-contracts-1b24845c7f72
const send = function (method, params = []) {
  const jsonrpc = '2.0'
  const id = 0
  return web3.currentProvider.send({ id, jsonrpc, method, params }, function(){})
}
let secsTimeTravelled = 0;
const timeTravel = async seconds => {
  secsTimeTravelled += seconds;
  await send('evm_increaseTime', [seconds])
  // await send('evm_mine') // Clipper does not need to mine the block to test
}

// Return seconds since epoch. This wrapper around Date.now is necessary in
// order to account for the simulated time travel.
async function nowSecs() {
  let bn = await web3.eth.getBlockNumber();
  let b = await web3.eth.getBlock(bn);
  return b.timestamp;
}

// Taken from https://stackoverflow.com/a/152573
// This is test-only method used as a way to get clearer understanding on
// hardhat objects, due to either sparse documentation or not great Google
// results yet.
function getMethods(obj) {
  var result = [];
  for (var id in obj) {
    try {
      if (typeof(obj[id]) == "function") {
        result.push(id);
        // Prints out the function definition in addition to 'id'. Commented
        // out because some objects have very large codebases.
        // result.push(id + ": " + obj[id].toString());
      }
    } catch (err) {
      result.push(id + ": inaccessible");
    }
  }
  return result;
}

// Taken from https://stackoverflow.com/a/39914235
// Usage: await sleep(5000);
// Should only be used as a quick hack to simulate await functionality.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to convert a big number. I got tired of writing the same
// code over and over.
function bigToNum(b) {
  return b.div(1e12).toNumber();
}

// Helper function just to get a console.loggable balance of signer.
async function getBal(owner) {
  const bal = await owner.getBalance();
  return bigToNum(bal);
}

// Returns address of token.
function addr(token) {
  if (token === ethers.constants.AddressZero) { return token; }
  return token.address;
}

// Converts big number to a recognizable number with decimals.
function strBign(n /*BigNumber*/, d /*int, decimals*/) {
  if (!d) { console.trace(); throw "Need a valid decimals, got: " + d; }
  var s = n.toString();
  const l = s.length
  if (l < d) {
    var remaining = d - l;
    while (remaining > 0) {
      s = "0" + s;
      remaining--;
    }
    return "0." + s;
  }
  return s.substring(0, l-d) + "." + s.substring(l-d);
}

async function strBign2(n, t) {
  return strBign(n, await getDecimals(t));
}

function printLine() {
  console.log('------------------------------------------------------');
}

function printBigMsg(S) {
  console.log('//----------------------------------------------------------------');
  for (let s of S) { console.log('// ' + s); }
  console.log('//----------------------------------------------------------------');
}

async function getDecimals(t) { // -> int
  if (t === '0x0000000000000000000000000000000000000000' /*eth*/) {return 18;}
  if (t.decimals) {
    let decimals = await t.decimals();
    return decimals+'';
  }
  throw 'invalid token, no decimals: ' + t;
}

let eth = '0x0000000000000000000000000000000000000000' ;

async function getSymbol(t) { // -> string
  if (t === eth) {return 'ETH';}
  if (t.symbol) {
    return await t.symbol();
  }
  throw 'invalid token, no symbol: ' + t;
}

// Convert BigNumber to JS floating point.
function bignToFloat(n /*BigNumber*/, D /*int, decimals*/) {
  var d = D;
  while (d > 7) {
    n = n.div(10);
    d--;
  }
  n = n.toNumber() / Math.pow(10, d);
  return n;
}

function floatToBign(n /*Number*/, D /*int, decimals*/) {
  var d = D;
  while(n < 1e7 && d > 0) {
    n *= 10;
    d--;
  }
  // This long expression is just: n * 10^d
  return ethers.BigNumber.from(Math.floor(n)).mul(
    ethers.BigNumber.from(10).pow(d) );
}

// Returns 1/n.
function invertBign(n /*BigNumber*/, D /*int, decimals*/) { // -> BigNumber
  n = bignToFloat(n, D);
  n = 1 / n;
  n = floatToBign(n, D);
  return n;
}

// Returns the eth used during the transaction.
async function getEthUsed(trans) {
  if (!trans.wait) { trans = await trans; }
  const receipt = await trans.wait();
  // console.log('gasUsed ' + U.strBign(receipt.gasUsed, 18));
  // console.log('gasPrice ' + trans.gasPrice);
  // console.log('gasPrice ' + U.strBign(trans.gasPrice, 18))
  return receipt.gasUsed.mul(trans.gasPrice);
}

// Returns variables that are useful to compare between state changes.
async function getState(A = {
  pool: null,
  xchg: null,
  owner: null,
  tokens: [] /*ERC20[]*/,
}) {
  let S = {};

  // Owner's balance of each token.
  S.tokens = [];
  for (let t of A.tokens) {
    if (t === eth) { S.tokens.push(await A.owner.getBalance()); }
    else { S.tokens.push(await t.balanceOf(A.owner.address)); }
  }

  // Pool's balance of each token.
  S.poolBal = [];
  for (let t of A.tokens) {
    if (t === eth) { S.poolBal.push(await A.pool.lastBalance(eth)); }
    else { S.poolBal.push(await A.pool.lastBalance(t.address)); }
  }

  S.supply = await A.pool.totalSupply();
  S.diluted = await A.pool.fullyDilutedSupply();
  S.inv = await A.xchg.invariant();
  S.bal = await A.pool.balanceOf(A.owner.address)
  return S;
}

let One = ethers.utils.parseUnits("1","ether");

// Executes one of {sellEthForToken, sellTokenForEth, sellTokenForToken}.
async function swap(A = {
  i: null, // input token.
  o: null, // output token.
  owner: null, // sender.
  n_i: null, // BigNumber, amount being sold.
  attach: null, // bool whether to attach eth to this call.
  minBuyAmount: null, // min desired amount of output token.
  ofac: null, // Address of OFAC recipient.
  ifc: null, // "interface", either otherExchange or otherPool.
}) {
  if (!A.ifc) { console.trace(); throw 'need A.ifc defined'; }
  let ifc = A.ifc;
  let recipient = A.ofac || addr(A.owner);
  if (A.i === eth) {
    if (A.attach) {
      // TODO: test otherPool also works.
      return await ifc.sellEthForToken(
        addr(A.o), recipient, A.minBuyAmount || One, 0,
        {'value': A.n_i});
    } else {
      return await ifc.sellEthForToken(
        addr(A.o), recipient, A.minBuyAmount || One, 0);
    }
  } else if (A.o === eth) {
    return await ifc.sellTokenForEth(
      addr(A.i), recipient, A.minBuyAmount || One.div(100),
      0);
  } else {
    return await ifc.sellTokenForToken(
      addr(A.i), addr(A.o), recipient, A.minBuyAmount || 1e4, 0);
  }
}

let BN = ethers.BigNumber;

async function basicSwapTest(A = {
  pool: null,
  xchg: null,
  owner: null,
  i: null, // input token.
  o: null, // output token.
  n_i: null, // Amount of input token to sell.

  transfer: null, // A function for moving balances between tokens.
  attach: false, // Whether to attach i to call. Relevant for ETH.
  minBuyAmount: null, // passthrough arg to the swap call.
  ofac: null, // string, OFAC address, passthru to swap call.
  ifc: null, // "interface", either otherExchange or otherPool.
}) {
  const stateArg = { pool: A.pool, xchg: A.xchg, owner: A.owner,
    tokens: [A.i, A.o] };
  const s0 = await getState(stateArg);

  //-----------------------------------------------------------------------
  // EVENT: swap between input and output tokens.
  //-----------------------------------------------------------------------
  // n_i is amount of input token to sell.
  // n_o is amount of output token to sell.
  A.n_i = A.n_i || One;

  // If we transferred AND attached ETH, then E_n_i (expected n_i) is 2*n_i.
  let E_n_i;
  if (A.transfer && A.attach) { E_n_i = A.n_i.mul(2); } else { E_n_i = A.n_i; }

  const E_n_o = await A.xchg.getSellQuote(addr(A.i), addr(A.o), E_n_i);

  // Whether to transfer before swapping tokens.
  let ethUsed = BN.from(0);
  if (A.transfer) {
    let t = A.transfer(A.i, A.owner, addr(A.pool), A.n_i);
    ethUsed = await getEthUsed(t);
  }

  trans = swap(A); // Actual swap occurs here.

  //-----------------------------------------------------------------------
  // Asserts.
  //-----------------------------------------------------------------------

  ethUsed = ethUsed.add(await getEthUsed(trans));
  // console.log('ETH used in transaction ' + strBign(ethUsed, 18));

  const s1 = await getState(stateArg);

  // // Assert invariant has slightly increased.
  // expect(U.bigToNum(s1.inv)).to.be.greaterThan(U.bigToNum(s0.inv));

  // This assert is only valid if pool actually has meaningful amount of
  // the output token left.
  if (s1.poolBal[1].gt(One.div(200))) {
    // percInvInc is calculated: 1 / ( inv1 / ( inv1 - inv0 ) )
    let percInvInc = 1/s1.inv.div( s1.inv.sub(s0.inv) ).toNumber();
    expect(percInvInc).to.be.at.most(0.004); // Assert increase <= 0.4%.
  }

  // Assert owner's input token decreased by exactly E_n_i.
  let diff_i = s1.tokens[0].sub(s0.tokens[0]);
  if (A.i === eth) { diff_i = diff_i.add(ethUsed); }
  expect(diff_i).to.equal(E_n_i.mul(-1));

  // Assert owner's output token increased by exactly E_n_o.
  let diff_o = s1.tokens[1].sub(s0.tokens[1]);
  if (A.o === eth) { diff_o = diff_o.add(ethUsed); }
  expect(diff_o).to.equal(E_n_o);

  // Assert Pool balance of input token increased by exactly E_n_i.
  const pool_i = s1.poolBal[0].sub(s0.poolBal[0]);
  expect(pool_i).to.equal(E_n_i);

  // Assert Pool balance of output token decreased by exactly E_n_o.
  const pool_o = s1.poolBal[1].sub(s0.poolBal[1]);
  expect(pool_o).to.equal(E_n_o.mul(-1));

  // Returns how much of the output token that the owner got.
  return {o: E_n_o};
}

// Deposits 'One' ETH into the pool.
// Returns an object of {
//   depositPromise which can be awaited,
//   receiptone, the receipt of the deposit.
//   transone, the transaction referring to the deposit.
// }
async function deposit(A = {
  pool: null, // pool receiving eth.
  owner: null, // person sending eth to pool.
  nDays: -1, // int
  num_eth: One, // BigNumber, e.g. One
  depositContract: null, // contract with ClipperPool to deposit something.
}) {
  let tx = A.owner.sendTransaction({
    to: A.pool.address,
    value: A.num_eth
  });
  let transone = await tx;
  let receiptone = await transone.wait();
  let depositPromise = A.depositContract.deposit(A.nDays);
  return { depositPromise, transone, receiptone };
}

exports.bigToNum = bigToNum;
exports.nowSecs = nowSecs;
exports.timeTravel = timeTravel;
exports.addr = addr;
exports.One = One;
exports.sleep = sleep;
exports.getMethods = getMethods;
exports.strBign = strBign;
exports.strBign2 = strBign2;
exports.printLine = printLine;
exports.printBigMsg = printBigMsg;
exports.getDecimals = getDecimals;
exports.getSymbol = getSymbol;
exports.invertBign = invertBign;
exports.getEthUsed = getEthUsed;
exports.getState = getState;
exports.swap = swap;
exports.basicSwapTest = basicSwapTest;
exports.deposit = deposit;
