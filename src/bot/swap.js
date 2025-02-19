const { calculateProfit, toDecimal, storeItInTempAsJSON } = require("../utils");
const cache = require("./cache");
const { setTimeout } = require("timers/promises");
const { balanceCheck } = require("./setup");
const { checktrans } = require("../utils/transaction.js");
const promiseRetry = require("promise-retry");

const waitabit = async (ms) => {
	const mySecondPromise = new Promise(function(resolve,reject){
		console.log('construct a promise...')
		setTimeout(() => {
			reject(console.log('Error in promise'));
		},ms)
	})
  }

const swap = async (jupiter, route) => {
	try {
		const performanceOfTxStart = performance.now();
		cache.performanceOfTxStart = performanceOfTxStart;

		if (process.env.DEBUG) storeItInTempAsJSON("routeInfoBeforeSwap", route);

		  // pull the trade priority
		  const priority = typeof cache.config.priority === "number" ? cache.config.priority : 123; //123 default if not set
		  cache.priority = priority;

		const { execute } = await jupiter.exchange({
			routeInfo: route,
			computeUnitPriceMicroLamports: priority,
		});
		const result = await execute();

		if (process.env.DEBUG) storeItInTempAsJSON("result", result);

		// Reset counter on success
		cache.tradeCounter.Failedbalancecheck = 0;
		cache.tradeCounter.errorcount = 0;

		const performanceOfTx = performance.now() - performanceOfTxStart;
		
		return [result, performanceOfTx];
	} catch (error) {
		console.log("Swap error: ", error);
	}
};
exports.swap = swap;

const failedSwapHandler = async(tradeEntry, inputToken, tradeAmount) => {
	// update counter
	cache.tradeCounter[cache.sideBuy ? "buy" : "sell"].fail++;

	// update trade history
	cache.config.storeFailedTxInHistory;

	// update trade history
	let tempHistory = cache.tradeHistory;
	tempHistory.push(tradeEntry);
	cache.tradeHistory = tempHistory;

	// Double check the balance is not the issue here. If so end the script to stop endless failed trans
	var realbalanceToken = await balanceCheck( inputToken );

	if (realbalanceToken<tradeAmount){
		cache.tradeCounter.Failedbalancecheck++;

		if (cache.tradeCounter.Failedbalancecheck>3){
			// Has to fail for 3 times before it ends the script. This is to cover cases where there is a delay in account updating pull
			console.log('Balance Lookup is too low for token: '+realbalanceToken+' < '+tradeAmount);
			console.log('Failed For: '+cache.tradeCounter.Failedbalancecheck+' times');
			process.exit();
		}
	}

	// Add one count to the error
	cache.tradeCounter.errorcount += 1;

	if (cache.tradeCounter.errorcount>100){
		console.log('Error Count is too high for swaps: '+cache.tradeCounter.errorcount);
		console.log('Ending to stop endless transactions failing');
		process.exit();
	}

};
exports.failedSwapHandler = failedSwapHandler;

const successSwapHandler = async (tx, tradeEntry, tokenA, tokenB) => {
	if (process.env.DEBUG) storeItInTempAsJSON(`txResultFromSDK_${tx?.txid}`, tx);

		// update counter
		cache.tradeCounter[cache.sideBuy ? "buy" : "sell"].success++;

		if (cache.config.tradingStrategy === "pingpong") {
			// update balance
			if (cache.sideBuy) {
				cache.lastBalance.tokenA = cache.currentBalance.tokenA;
				cache.currentBalance.tokenA = 0;
				cache.currentBalance.tokenB = tx.outputAmount;
			} else {
				cache.lastBalance.tokenB = cache.currentBalance.tokenB;
				cache.currentBalance.tokenB = 0;
				cache.currentBalance.tokenA = tx.outputAmount;
			}

			// update profit
			if (cache.sideBuy) {
				cache.currentProfit.tokenA = 0;
				cache.currentProfit.tokenB = calculateProfit(
					String(cache.initialBalance.tokenB),
					String(cache.currentBalance.tokenB)
				);
			} else {
				cache.currentProfit.tokenB = 0;
				cache.currentProfit.tokenA = calculateProfit(
					String(cache.initialBalance.tokenA),
					String(cache.currentBalance.tokenA)
				);
			}

			// update trade history
			let tempHistory = cache.tradeHistory;

			tradeEntry.inAmount = toDecimal(
				tx.inputAmount,
				cache.sideBuy ? tokenA.decimals : tokenB.decimals
			);
			tradeEntry.outAmount = toDecimal(
				tx.outputAmount,
				cache.sideBuy ? tokenB.decimals : tokenA.decimals
			);

			tradeEntry.profit = calculateProfit(
				String(cache.lastBalance[cache.sideBuy ? "tokenB" : "tokenA"]),
				String(tx.outputAmount)
			);
			tempHistory.push(tradeEntry);
			cache.tradeHistory = tempHistory;

		}
		if (cache.config.tradingStrategy === "arbitrage") {
			/** check real amounts because Jupiter SDK returns wrong amounts
			 *  when we trading TokenA <> TokenA (arbitrage)
			 */

			try {
				// BETA LOOKUP FOR RESULT VIA RPC
				//try catch error handling
				var txresult = [];
				var err2 = -1;
				var rcount = 0;
				var retries = 30;

				const fetcher = async (retry) => {

					console.log('Looking for result via RPC.');
					rcount++;

					if (rcount>=retries){
						// Exit max retries
						console.log(`Max attempts to fetch transaction. Assuming it did not complete.`);
						return -1;
					}

					[txresult, err2] = await checktrans(tx?.txid,cache.walletpubkeyfull);
					//console.log(`After txresult ERR:${err2}`);
					//console.log(txresult);
					//console.log(tokenA.address);
					
					if (err2==0 && txresult) {
						if (txresult?.[tokenA.address]?.change>0) {

							// update balance
							cache.lastBalance.tokenA = cache.currentBalance.tokenA;
							cache.currentBalance.tokenA = (cache.currentBalance.tokenA+txresult?.[tokenA.address]?.change);
						
							// update profit
							cache.currentProfit.tokenA = calculateProfit(
								String(cache.initialBalance.tokenA),
								String(cache.currentBalance.tokenA)
							);

							// update trade history
							let tempHistory = cache.tradeHistory;

							tradeEntry.inAmount = toDecimal(
								cache.lastBalance.tokenA, tokenA.decimals
							);
							tradeEntry.outAmount = toDecimal(
								cache.currentBalance.tokenA, tokenA.decimals
							);

							tradeEntry.profit = calculateProfit(
								String(cache.lastBalance.tokenA),
								String(cache.currentBalance.tokenA)
							);
							tempHistory.push(tradeEntry);
							cache.tradeHistory = tempHistory;

						    //console.log(`Tx result with output token, returning..`);
							return txresult;
						} else {
							retry(new Error("Transaction was not posted yet... Retrying..."));
						}
					} else if(err2==2){
						// Transaction failed. Kill it and retry
						err.message = JSON.stringify(txresult);
						return -1;
					} else{
						retry(new Error("Transaction was not posted yet. Retrying..."));
					}
				};

				const lookresult = await promiseRetry(fetcher, {
						retries: retries,
						minTimeout: 1000,
						maxTimeout: 4000,
						randomize: true,
					});

				if (lookresult==-1){
					//console.log('Lookup Shows Failed Transaction.');
					outputamt = 0;
					err.status=true;
				} else {
					// Track the output amount
					inputamt = txresult[tokenA.address].start;
					outputamt = txresult[tokenA.address].end;
					//console.log(`Succss Lookup ${inputamt} to ${outputamt}`);

					cache.currentProfit.tokenA = calculateProfit(
							cache.initialBalance.tokenA,
							cache.currentBalance.tokenA
					);

					// update trade history
					let tempHistory = cache.tradeHistory;

					tradeEntry.inAmount = toDecimal(inputamt, tokenA.decimals);
					tradeEntry.outAmount = toDecimal(outputamt, tokenA.decimals);

					tradeEntry.profit = calculateProfit(tradeEntry.inAmount,tradeEntry.outAmount);
					tempHistory.push(tradeEntry);
					cache.tradeHistory = tempHistory;
				}

			} catch (error) {
					console.log("Fetch Result Error: ", error);  
			}
		}
};
exports.successSwapHandler = successSwapHandler;
