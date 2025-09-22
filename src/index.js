require("dotenv").config()
const moment = require("moment")
const promisePoller = require("promise-poller").default

const { ethers, utils, WitOracle } = require("@witnet/ethers")

const commas = (number) => {
	const parts = number.toString().split(".")
	const result =
		parts.length <= 1
			? `${parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`
			: `${parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${parts[1]}`
	return result
}

const CHECK_BALANCE_SECS = process.env.RANDOMIZER_CHECK_BALANCE_SECS
const CONFIRMATIONS = process.env.RANDOMIZER_CONFIRMATIONS || 2
const GAS_PRICE = process.env.RANDOMIZER_GAS_PRICE
const HEARTBEAT_SECS = process.env.RANDOMIZER_HEARBEAT_SECS || 3600
const MIN_BALANCE = process.env.RANDOMIZER_MIN_BALANCE || 0
const NETWORK =
	_spliceFromArgs(process.argv, `--network`) || process.env.RANDOMIZER_NETWORK
const POLLING_MSECS = process.env.RANDOMIZER_POLLING_MSECS || 15000
const GATEWAY_HOST = (
    _spliceFromArgs(process.argv, `--host`) || process.env.RANDOMIZER_GATEWAY_HOST || "http://127.0.0.1"
).replace(/\/$/, "")
const GATEWAY_PORT =
	_parseIntFromArgs(process.argv, `--port`) ||
	process.env.RANDOMIZER_GATEWAY_PORT
const SIGNER =
	_spliceFromArgs(process.argv, `--signer`) || process.env.RANDOMIZER_SIGNER
const TARGET =
	_spliceFromArgs(process.argv, `--target`) ||
	process.env.RANDOMIZER_TARGET ||
	undefined

main()

async function main() {
    const headline = `EVM RANDOMIZER v${require("../package.json").version}`
	console.info("=".repeat(headline.length))
    console.info(headline)

	if (!GATEWAY_PORT) throw new Error(`Fatal: no PORT was specified.`)
	else if (!TARGET) throw new Error(`Fatal: no TARGET was specified.`)

    console.info(`> Ethereum gateway: ${GATEWAY_HOST}:${GATEWAY_PORT}`)

	const witOracle = SIGNER
		? await WitOracle.fromJsonRpcUrl(`${GATEWAY_HOST}:${GATEWAY_PORT}`, SIGNER)
		: await WitOracle.fromJsonRpcUrl(`${GATEWAY_HOST}:${GATEWAY_PORT}`)
	const { network, provider, signer } = witOracle

	if (NETWORK && network !== NETWORK) {
		throw new Error(
			`Fatal: connected to wrong network: ${network.toUpperCase()}`,
		)
	}

	console.info(`> Ethereum network: ${network}`)

	const randomizer = await witOracle.getWitRandomnessAt(TARGET)
	const artifact = await randomizer.getEvmImplClass()
	const symbol = utils.getEvmNetworkSymbol(network)
	const version = await randomizer.getEvmImplVersion()

	console.info(
		`> ${artifact}:${" ".repeat(Math.max(0, 16 - artifact.length))} ${TARGET} [${version}]`,
	)

	let randomizeWaitBlocks
	if (artifact === "WitRandomnessV3") {
		const settings = await randomizer.getSettings()
		console.info(`> On-chain settings`, settings)
		randomizeWaitBlocks = settings.randomizeWaitBlocks
	}

	// set start clock
	let lastClock = Date.now()

	// check initial balance
	const balance = await checkBalance()
	if (Number(ethers.formatEther(balance)) < MIN_BALANCE) {
		console.error(
			`> Fatal: insufficient balance: ${ethers.formatEther(balance)} < ${MIN_BALANCE} ${symbol}`,
		)
		process.exit(1)
	}

	// check balance periodically
	console.info(
		`> Checking balance every ${CHECK_BALANCE_SECS || 900} seconds ...`,
	)
	console.info(`> Signer address: ${signer.address}`)
	setInterval(checkBalance, (CHECK_BALANCE_SECS || 900) * 1000)

	// randomize upon startup:
	console.info(`> Randomizing every ${HEARTBEAT_SECS} seconds ... `)
	randomize()

	async function checkBalance() {
		return provider
			.getBalance(signer)
			.then((balance) => {
				if (Number(ethers.formatEther(balance)) < MIN_BALANCE) {
					console.info(
						`> Low balance !!! ${ethers.formatEther(balance)} ${symbol} (${signer.address})`,
					)
				} else {
					console.info(
						`> Signer balance: ${ethers.formatEther(balance)} ${symbol}`,
					)
				}
				return balance
			})
			.catch((err) => {
				console.error(err)
			})
	}

	async function randomize() {
		lastClock = Date.now()
		console.info(`> Randomizing new block ...`)
		let isRandomized = false
		randomizer
			.randomize({
				evmConfirmations: CONFIRMATIONS || 2,
				evmGasPrice: GAS_PRICE || undefined,
			})
			.then(async (receipt) => {
				console.info(`  - Block number:  ${commas(receipt.blockNumber)}`)
				console.info(`  - Block hash:    ${receipt.blockHash}`)
				console.info(`  - Transaction:   ${receipt.hash}`)
				console.info(
					`  - Tx. gas price: ${
						receipt.gasPrice < 10 ** 9
							? Number(Number(receipt.gasPrice) / 10 ** 9).toFixed(9)
							: commas(Number(Number(receipt.gasPrice) / 10 ** 9).toFixed(1))
					} gwei`,
				)
				const tx = await receipt.getTransaction()
				console.info(
					`  - Tx. cost:      ${ethers.formatEther(receipt.gasPrice * receipt.gasUsed + tx.value)} ${symbol}`,
				)
				return promisePoller({
					taskFn: () =>
						randomizer
							.isRandomized(tx.blockNumber)
							.then(async (isRandomized) => ({
								isRandomized,
								blockNumber: await provider.getBlockNumber(),
								randomizeBlock: tx.blockNumber,
							})),
					shouldContinue: (err, result) => {
						const { isRandomized, blockNumber, randomizeBlock } = result
						if (err) {
							console.info(err)
						} else if (!isRandomized) {
							const plus = Number(blockNumber) - Number(randomizeBlock)
							if (randomizeWaitBlocks && plus > randomizeWaitBlocks) {
								return false
							} else {
								console.info(
									`> Awaiting randomness for block ${commas(randomizeBlock)} ... T + ${commas(plus)}`,
								)
							}
						}
						return !isRandomized
					},
					interval: POLLING_MSECS,
				}).then(async (result) => {
					if (result.isRandomized) {
						isRandomized = true
						console.info(`> Randomized block ${commas(receipt.blockNumber)}:`)
						const trails = await randomizer.fetchRandomnessAfterProof(
							receipt.blockNumber,
						)
						console.info(`  - Finality block:   ${commas(trails.finality)}`)
						console.info(`  - Witnet DRT hash:  ${trails.trail?.slice(2)}`)
						if (artifact === "WitRandomnessV3") {
							console.info(`  - Wit/Oracle UUID:  ${trails.uuid?.slice(2)}`)
							console.info(
								`  - Wit/Oracle RNG:   ${(await randomizer.fetchRandomnessAfter(receipt.blockNumber))?.slice(2)}`,
							)
						} else {
							console.info(`  - Witnet result:    ${trails.uuid?.slice(2)}`)
						}
						console.info(
							`  - Witnet timestamp: ${moment.unix(trails.timestamp)}`,
						)
					}
					return result
				})
			})
			.then((result) => {
				if (result.isRandomized) {
					const elapsed = Date.now() - lastClock
					const timeout = Math.max(0, HEARTBEAT_SECS * 1000 - elapsed)
					console.info(
						`> Waiting ${Number(timeout / 1000).toFixed(1)} seconds before next randomize ...`,
					)
					setTimeout(randomize, timeout)
				} else {
					console.info(
						`> Randomizing block ${commas(result.randomizeBlock)} is taking too long !!!`,
					)
					setTimeout(randomize, 0)
				}
			})
			.catch((err) => {
				console.error(err)
				if (isRandomized) {
					const elapsed = Date.now() - lastClock
					const timeout = Math.max(0, HEARTBEAT_SECS * 1000 - elapsed)
					console.info(
						`> Waiting ${Number(timeout / 1000).toFixed(1)} seconds before next randomize ...`,
					)
					setTimeout(randomize, timeout)
				} else {
					console.info(
						`> Retrying in ${Math.floor(POLLING_MSECS / 1000)} seconds before next randomize ...`,
					)
					setTimeout(randomize, POLLING_MSECS)
				}
			})
	}
}

function _parseIntFromArgs(args, flag) {
	const argIndex = args.indexOf(flag)
	if (argIndex >= 0 && args.length > argIndex + 1) {
		const value = parseInt(args[argIndex + 1], 10)
		args.splice(argIndex, 2)
		return value
	}
}

function _spliceFromArgs(args, flag) {
	const argIndex = args.indexOf(flag)
	if (argIndex >= 0 && args.length > argIndex + 1) {
		const value = args[argIndex + 1]
		args.splice(argIndex, 2)
		return value
	}
}
