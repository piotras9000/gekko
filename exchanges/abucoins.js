var Abucoins = require('abucoinsnode');
var _ = require('lodash');
var moment = require('moment');

const util = require('../core/util');
const Errors = require('../core/error');
const log = require('../core/log');

const BATCH_SIZE = 100;
const QUERY_DELAY = 300;

// Helper methods
function joinCurrencies(currencyA, currencyB){
  return currencyB + '-' + currencyA;
}

var Trader = function(config) {
  _.bindAll(this);

  this.post_only = true;
  this.name = 'Abucoins';
  this.scanback = false;
  this.scanbackTid = 0;
  this.scanbackResults = [];
  this.asset = config.asset;
  this.currency = config.currency;

  this.api_url = 'https://api.abucoins.com';

  if (_.isObject(config)) {
    this.key = config.key;
    this.secret = config.secret;
    this.passphrase = config.passphrase;

    this.pair = [config.asset, config.currency].join('-').toUpperCase();
    this.post_only =
      typeof config.post_only !== 'undefined' ? config.post_only : true;

  }

  this.abucoins_public = new Abucoins.PublicClient(
    this.pair,
    this.api_url
  );
  this.abucoins = new Abucoins.AuthenticatedClient(
    this.key,
    this.secret,
    this.passphrase,
    this.api_url
  );
};

var retryCritical = {
  retries: 10,
  factor: 1.2,
  minTimeout: 10 * 1000,
  maxTimeout: 60 * 1000,
};

var retryForever = {
  forever: true,
  factor: 1.2,
  minTimeout: 10 * 1000,
  maxTimeout: 300 * 1000,
};

// Probably we need to update these string
var recoverableErrors = new RegExp(
  /(SOCKETTIMEDOUT|TIMEDOUT|CONNRESET|CONNREFUSED|NOTFOUND|Rate limit exceeded|Response code 5)/
);

Trader.prototype.processError = function(funcName, error) {
  if (!error) return undefined;

  if (!error.message.match(recoverableErrors)) {
    log.error(
      `[abucoins.js] (${funcName}) returned an irrecoverable error: ${
        error.message
      }`
    );
    return new Errors.AbortError('[abucoins.js] ' + error.message);
  }

  log.debug(
    `[abucoins.js] (${funcName}) returned an error, retrying: ${error.message}`
  );
  return new Errors.RetryError('[abucoins.js] ' + error.message);
};

Trader.prototype.handleResponse = function(funcName, callback) {
  return (error, response, body) => {
    if (body && !_.isEmpty(body.message)) error = new Error(body.message);
    else if (
      response &&
      response.statusCode < 200 &&
      response.statusCode >= 300
    )
      error = new Error(`Response code ${response.statusCode}`);

    return callback(this.processError(funcName, error), body);
  };
};

Trader.prototype.getPortfolio = function(callback) {
  var result = function(err, data) {
    if (err) return callback(err);
    if (typeof data.message !== "undefined") return callback(new Error(data.message));

    var portfolio = data.map(function(account) {
      return {
        name: account.currency.toUpperCase(),
        amount: parseFloat(account.available),
      };
    });
    callback(undefined, portfolio);
  };

  let handler = cb =>
    this.abucoins.getAccounts(this.handleResponse('getPortfolio', cb));
  util.retryCustom(retryForever, _.bind(handler, this), _.bind(result, this));
};

Trader.prototype.getTicker = function(callback) {
  var result = function(err, data) {
    if (err) return callback(err);
    if (typeof data.message !== "undefined") return callback(new Error(data.message));
    callback(undefined, { bid: +data.bid, ask: +data.ask });
  };

  var currencyPair = joinCurrencies(this.currency, this.asset);

  let handler = cb =>
    this.abucoins_public.getProductTicker(currencyPair, this.handleResponse('getTicker', cb));
  util.retryCustom(retryForever, _.bind(handler, this), _.bind(result, this));
};

Trader.prototype.getFee = function(callback) {
  //https://www.abucoins.com/fees
  const fee = (this.currency == 'USD' || this.currency == 'PLN' || this.currency == 'EUR') ? 0.0025 : 0.001;

  //There is no maker fee, not sure if we need taker fee here
  //If post only is enabled, abucoins only does maker trades which are free
  callback(undefined, this.post_only ? 0 : fee);
};

Trader.prototype.buy = function(amount, price, callback) {
  var buyParams = {
    price: this.getMaxDecimalsNumber(price, this.currency == 'BTC' ? 5 : 2),
    size: this.getMaxDecimalsNumber(amount),
    product_id: this.pair,
    post_only: this.post_only,
  };

  var result = (err, data) => {
    if (err) return callback(err);
    if (typeof data.message !== "undefined") return callback(new Error(data.message));
    callback(undefined, data.id);
  };

  let handler = cb =>
    this.abucoins.buy(buyParams, this.handleResponse('buy', cb));
  util.retryCustom(retryCritical, _.bind(handler, this), _.bind(result, this));
};

Trader.prototype.sell = function(amount, price, callback) {
  var sellParams = {
    price: this.getMaxDecimalsNumber(price, this.currency == 'BTC' ? 5 : 2),
    size: this.getMaxDecimalsNumber(amount),
    product_id: this.pair,
    post_only: this.post_only,
  };

  var result = function(err, data) {
    if (err) return callback(err);
    if (typeof data.message !== "undefined") return callback(new Error(data.message));
    callback(undefined, data.id);
  };

  let handler = cb =>
    this.abucoins.sell(sellParams, this.handleResponse('sell', cb));
  util.retryCustom(retryCritical, _.bind(handler, this), _.bind(result, this));
};

Trader.prototype.checkOrder = function(order, callback) {
  var result = function(err, data) {
    if (err) return callback(err);

    var status = data.status;
    if (status == 'done') {
      return callback(undefined, true);
    } else if (status == 'rejected') {
      return callback(undefined, false);
    } else if (status == 'pending') {
      return callback(undefined, false);
    }
    callback(undefined, false);
  };

  let handler = cb =>
    this.abucoins.getOrder(order, this.handleResponse('checkOrder', cb));
  util.retryCustom(retryCritical, _.bind(handler, this), _.bind(result, this));
};

Trader.prototype.getOrder = function(order, callback) {
  var result = function(err, data) {
    if (err) return callback(err);
    if (typeof data.message !== "undefined") return callback(new Error(data.message));

    var price = parseFloat(data.price);
    var amount = parseFloat(data.filled_size);
    var date = moment(data.done_at);

    callback(undefined, { price, amount, date });
  };

  let handler = cb =>
    this.abucoins.getOrder(order, this.handleResponse('getOrder', cb));
  util.retryCustom(retryForever, _.bind(handler, this), _.bind(result, this));
};

Trader.prototype.cancelOrder = function(order, callback) {
  // callback for cancelOrder should be true if the order was already filled, otherwise false
  var result = function(err, data) {
    if(err) {
      log.error('Error cancelling order:', err);
      return callback(true);  // need to catch the specific error but usually an error on cancel means it was filled
    }

    if (typeof data.message !== "undefined") return callback(true);

    return callback(false);
  };

  let handler = cb =>
    this.abucoins.cancelOrder(order, this.handleResponse('cancelOrder', cb));
  util.retryCustom(retryForever, _.bind(handler, this), _.bind(result, this));
};

Trader.prototype.getTrades = function(since, callback, descending) {
  var lastScan = 0;

  var process = function(err, data) {
    if (err) return callback(err);
    if (typeof data.message !== "undefined") return callback(new Error(data.message));

    var result = _.map(data, function(trade) {
      return {
        tid: trade.trade_id,
        amount: parseFloat(trade.size),
        date: moment.utc(trade.time).format('X'),
        price: parseFloat(trade.price),
      };
    });

    if (this.scanback) {
      var last = _.last(data);
      var first = _.first(data);

      // Try to find trade id matching the since date
      if (!this.scanbackTid) {
        // either scan for new ones or we found it.
        if (moment.utc(last.time) < moment.utc(since)) {
          this.scanbackTid = last.trade_id;
        } else {
          log.debug('Scanning backwards...' + last.time);
          setTimeout(() => {
            var currencyPair = joinCurrencies(this.currency, this.asset);
            let handler = cb =>
              this.abucoins_public.getProductTrades(
                currencyPair,
                {
                  after: last.trade_id - BATCH_SIZE * lastScan,
                  limit: BATCH_SIZE,
                },
                this.handleResponse('getTrades', cb)
              );
            util.retryCustom(
              retryForever,
              _.bind(handler, this),
              _.bind(process, this)
            );
          }, QUERY_DELAY);
          lastScan++;
          if (lastScan > 100) {
            lastScan = 10;
          }
        }
      }

      if (this.scanbackTid) {
        // if scanbackTid is set we need to move forward again
        log.debug(
          'Backwards: ' +
            last.time +
            ' (' +
            last.trade_id +
            ') to ' +
            first.time +
            ' (' +
            first.trade_id +
            ')'
        );

        this.scanbackResults = this.scanbackResults.concat(result.reverse());

        if (this.scanbackTid != first.trade_id) {
          this.scanbackTid = first.trade_id;
          setTimeout(() => {
            var currencyPair = joinCurrencies(this.currency, this.asset);
            let handler = cb =>
              this.abucoins_public.getProductTrades(
                currencyPair,
                { after: this.scanbackTid + BATCH_SIZE + 1, limit: BATCH_SIZE },
                this.handleResponse('getTrades', cb)
              );
            util.retryCustom(
              retryForever,
              _.bind(handler, this),
              _.bind(process, this)
            );
          }, QUERY_DELAY);
        } else {
          this.scanback = false;
          this.scanbackTid = 0;

          log.debug('Scan finished: data found:' + this.scanbackResults.length);
          callback(null, this.scanbackResults);

          this.scanbackResults = [];
        }
      }
    } else {
      callback(null, result.reverse());
    }
  };

  if (since || this.scanback) {
    this.scanback = true;
    if (this.scanbackTid) {
      var currencyPair = joinCurrencies(this.currency, this.asset);
      let handler = cb =>
        this.abucoins_public.getProductTrades(
          currencyPair,
          { after: this.scanbackTid + BATCH_SIZE + 1, limit: BATCH_SIZE },
          this.handleResponse('getTrades', cb)
        );
      util.retryCustom(
        retryForever,
        _.bind(handler, this),
        _.bind(process, this)
      );
    } else {
      log.debug('Scanning back in the history needed...');
      log.debug(moment.utc(since).format());
    }
  }
  var currencyPair = joinCurrencies(this.currency, this.asset);
  let handler = cb =>
    this.abucoins_public.getProductTrades(
      currencyPair,
      { limit: BATCH_SIZE },
      this.handleResponse('getTrades', cb)
    );
  util.retryCustom(retryForever, _.bind(handler, this), _.bind(process, this));
};

Trader.prototype.getMaxDecimalsNumber = function(number, decimalLimit = 8) {
  var decimalNumber = parseFloat(number);

  // The ^-?\d*\. strips off any sign, integer portion, and decimal point
  // leaving only the decimal fraction.
  // The 0+$ strips off any trailing zeroes.
  var decimalCount = (+decimalNumber).toString().replace(/^-?\d*\.?|0+$/g, '')
    .length;

  var decimalMultiplier = 1;
  for (i = 0; i < decimalLimit; i++) {
    decimalMultiplier *= 10;
  }

  return decimalCount <= decimalLimit
    ? decimalNumber.toString()
    : (
        Math.floor(decimalNumber * decimalMultiplier) / decimalMultiplier
      ).toFixed(decimalLimit);
};

Trader.getCapabilities = function() {
  return {
    name: 'Abucoins',
    slug: 'abucoins',
    currencies: ['PLN', 'EUR', 'USD', 'BTC'],
    assets: ['BTC','ETH', 'LTC', 'ETC', 'ZEC', 'STRAT', 'DASH', 'XMR', 'XEM', 'GNT', 'REP', 'XRP', 'BCH', 'SC', 'BTG', 'LSK', 'HSR','QTUM','ADA','TRX','ARK','EOS'],
    markets: [
      { pair: ['BTC', 'ETH'], minimalOrder: { amount: 0.001, unit: 'asset' } },
      { pair: ['BTC', 'LTC'], minimalOrder: { amount: 0.001, unit: 'asset' } },
      { pair: ['BTC', 'ETC'], minimalOrder: { amount: 0.001, unit: 'asset' } },
      { pair: ['BTC', 'ZEC'], minimalOrder: { amount: 0.001, unit: 'asset' } },
      { pair: ['BTC', 'STRAT'], minimalOrder: { amount: 0.01, unit: 'asset' } },
      { pair: ['BTC', 'DASH'], minimalOrder: { amount: 0.001, unit: 'asset' } },
      { pair: ['BTC', 'XMR'], minimalOrder: { amount: 0.001, unit: 'asset' } },
      { pair: ['BTC', 'SC'], minimalOrder: { amount: 1, unit: 'asset' } },
      { pair: ['BTC', 'XEM'], minimalOrder: { amount: 1, unit: 'asset' } },
      { pair: ['BTC', 'GNT'], minimalOrder: { amount: 0.01, unit: 'asset' } },
      { pair: ['BTC', 'REP'], minimalOrder: { amount: 0.01, unit: 'asset' } },
      { pair: ['BTC', 'XRP'], minimalOrder: { amount: 0.01, unit: 'asset' } },
      { pair: ['BTC', 'BCH'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['PLN', 'BTC'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['USD', 'BTC'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['EUR', 'BTC'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['PLN', 'ETH'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['BTC', 'BTG'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['PLN', 'BCH'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['USD', 'BCH'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['EUR', 'BCH'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['USD', 'ETH'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['EUR', 'ETH'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['PLN', 'BTG'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['USD', 'BTG'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['EUR', 'BTG'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['BTC', 'LSK'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['PLN', 'LSK'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['USD', 'LSK'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['EUR', 'LSK'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['BTC', 'HSR'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['BTC', 'QTUM'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['BTC', 'ADA'], minimalOrder: { amount: 0.001, unit: 'asset' } },
      { pair: ['BTC', 'TRX'], minimalOrder: { amount: 0.01, unit: 'asset' } },
      { pair: ['BTC', 'ARK'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
      { pair: ['BTC', 'EOS'], minimalOrder: { amount: 0.0001, unit: 'asset' } },
    ],
    requires: ['key', 'secret', 'passphrase'],
    providesHistory: 'date',
    providesFullHistory: true,
    tid: 'tid',
    tradable: true,
    forceReorderDelay: false
  };
};

module.exports = Trader;
