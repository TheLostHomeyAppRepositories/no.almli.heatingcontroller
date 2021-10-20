'use strict';

const Homey = require('homey');
const _ = require('lodash');
const dayjs = require('dayjs');
const pricesLib = require('../../lib/prices');
const nordpool = require('../../lib/nordpool');
const heating = require('../../lib/heating');

module.exports = class HeatingControllerDevice extends Homey.Device {

  async onInit() {
    this.log(this.getName() + ' -> device initialized');
    await this.fixPrice(this.getSetting('currency'));
    this._at_home = undefined;
    this._home_override = undefined;
    this._home_on_next_period = false;
    this._ho_off_next_period = false;

    this._lastFetchData = undefined;
    this._lastPrice = undefined;
    this._prices = undefined;

    this.registerCapabilityListener('onoff', async (value, opts) => {
      if (value) {
        await this.homey.app._homeWasSetOnTrigger.trigger(this);
      } else {
        await this.homey.app._homeWasSetOffTrigger.trigger(this);
      }
      this.log(this.getName() + ' -> onoff changed: ', value, opts);
      return this.checkTime(value);
    });

    this.scheduleCheckTime(5);
  }

  async fixPrice(selectedCurrency) {
    if (this.hasCapability('price')) {
      await this.removeCapability('price');
    }
    for (let currency of ['DKK', 'EUR', 'NOK', 'SEK']) {
      if (currency !== selectedCurrency &&
        this.hasCapability(`price_${currency}`)) {
        await this.removeCapability(`price_${currency}`);
      }
    }
    if (!this.hasCapability(`price_${selectedCurrency}`)) {
      await this.addCapability(`price_${selectedCurrency}`);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('currency')) {
      await this.fixPrice(newSettingsObj.currency);
      this._lastFetchData = undefined;
      this._lastPrice = undefined;
      this.scheduleCheckTime(5);
    }
  }

  async onActionSetAtHomeOn(args, state) {
    const device = args.device;
    await this.homey.app._homeWasSetOnTrigger.trigger(device);
    await device.setCapabilityValue('onoff', true).catch(err => this.log('Error:', err));
    return device.checkTime(true);
  }

  async onActionSetAtHomeOff(args, state) {
    const device = args.device;
    device._home_on_next_period = false;
    await this.homey.app._homeWasSetOffTrigger.trigger(device);
    await device.setCapabilityValue('onoff', false).catch(err => this.log('Error:', err));
    return device.checkTime(false);
  }

  async onActionSetAtHomeOffAuto(args, state) {
    const device = args.device;
    device._home_on_next_period = true;
    await this.homey.app._homeWasSetOffTrigger.trigger(device);
    await device.setCapabilityValue('onoff', false).catch(err => this.log('Error:', err));
    return device.checkTime(false);
  }

  async onActionSetHomeOverrideOn(args, state) {
    const device = args.device;
    device._ho_off_next_period = false;
    await this.homey.app._homeOverrideSetOnTrigger.trigger(device);
    await device.setCapabilityValue('home_override', true).catch(err => this.log('Error:', err));
    return device.checkTime(undefined, true);
  }

  async onActionSetHomeOverrideOnAuto(args, state) {
    const device = args.device;
    device._ho_off_next_period = true;
    await this.homey.app._homeOverrideSetOnTrigger.trigger(device);
    await device.setCapabilityValue('home_override', true).catch(err => this.log('Error:', err));
    return device.checkTime(undefined, true);
  }

  async onActionSetHomeOverrideOff(args, state) {
    const device = args.device;
    await this.homey.app._homeOverrideSetOffTrigger.trigger(device);
    await device.setCapabilityValue('home_override', false).catch(err => this.log('Error:', err));
    return device.checkTime(undefined, false);
  }

  async onActionSetHolidayToday(args, state) {
    const device = args.device;
    await device.setSettings({ holiday_today: args.holiday }).catch(err => this.log('Error:', err));
    return device.checkTime();
  }

  onAdded() {
    this.log(this.getName() + ' -> virtual device added', this.getData().id);
  }

  onDeleted() {
    this._deleted = true;
    this.clearCheckTime();
    this.log(this.getName() + ' -> virtual device deleted');
  }

  clearCheckTime() {
    if (this.curTimeout) {
      this.homey.clearTimeout(this.curTimeout);
      this.curTimeout = undefined;
    }
  }

  scheduleCheckTime(seconds = 60) {
    if (this._deleted) {
      return;
    }
    this.clearCheckTime();
    this.log(`Checking time in ${seconds} seconds`);
    this.curTimeout = this.homey.setTimeout(this.checkTime.bind(this), seconds * 1000);
  }

  async checkTime(onoff, home_override) {
    if (this._deleted) {
      return;
    }
    try {
      this.log('checkTime with device: ', this.getData().id);
      this.clearCheckTime();

      if (onoff === false || onoff === true) {
        this._at_home = onoff;
      } else {
        this._at_home = await this.getCapabilityValue('onoff');
      }
      if (this._at_home === undefined || this._at_home === null) {
        this._at_home = true;
        await this.setCapabilityValue('onoff', this._at_home).catch(err => this.log('Error:', err));
      }

      if (home_override === false || home_override === true) {
        this._home_override = home_override;
      } else {
        this._home_override = await this.getCapabilityValue('home_override');
      }
      if (this._home_override === undefined || this._home_override === null) {
        this._home_override = false;
        await this.setCapabilityValue('home_override', this._home_override).catch(err => this.log('Error:', err));
      }

      if (this.shallFetchData()) {
        await this.fetchData();
      }
      if (this._prices) {
        await this.onData();
      }
    } catch (err) {
      this.log('checkTime error', err);
    } finally {
      this.scheduleCheckTime();
    }
  }

  async fetchData() {
    try {
      let settings = this.getSettings();
      let priceArea = settings.priceArea || 'Oslo';
      let currency = settings.currency || 'EUR';
      this.log('fetchData: ', this.getData().id, priceArea, currency);
      const localTime = dayjs().tz().startOf('day');
      const result = await Promise.all([
        nordpool.getHourlyPrices(localTime, { priceArea: priceArea, currency: currency }),
        nordpool.getHourlyPrices(localTime.add(1, 'day'), { priceArea: priceArea, currency: currency })
      ]);
      let prices = result[0];
      Array.prototype.push.apply(prices, result[1]);
      this._lastFetchData = dayjs().tz();
      this._prices = prices;
      this.log('fetchData: got data ', this.getData().id, prices.length);
    } catch (err) {
      this.log('fetchData error', err);
    }
  }

  toHour(aDate) {
    return aDate.startOf('hour').toISOString();
  }

  shallFetchData() {
    return !this._prices
      || !this._lastFetchData
      || this.toHour(this._lastFetchData) !== this.toHour(dayjs().tz());
  }

  async onData() {
    const localTime = dayjs().tz();
    let heatingOptions = this._getHeatingOptions();
    let calcHeating = heating.calcHeating(localTime, this._at_home, this._home_override, heatingOptions);
    let nigthAtWorkChanged = false;
    this.log('calcHeating', calcHeating);

    let curNight = await this.getCapabilityValue('night');
    if (curNight === undefined || curNight === null || calcHeating.night !== curNight) {
      nigthAtWorkChanged = true;
      await this.setCapabilityValue('night', calcHeating.night).catch(err => this.log('Error:', err));
      if (calcHeating.night) {
        await this.homey.app._nightStartsTrigger.trigger(this);
        this.log('night starts trigger');
      } else {
        await this.homey.app._nightEndsTrigger.trigger(this);
        this.log('night ends trigger');
      }
    }

    let curAtWork = await this.getCapabilityValue('at_work');
    if (curAtWork === undefined || curAtWork === null || calcHeating.atWork !== curAtWork) {
      nigthAtWorkChanged = true;
      await this.setCapabilityValue('at_work', calcHeating.atWork).catch(err => this.log('Error:', err));
      if (calcHeating.atWork) {
        await this.homey.app._atWorkStartsTrigger.trigger(this);
        this.log('at_work starts trigger');
      } else {
        await this.homey.app._atWorkEndsTrigger.trigger(this);
        this.log('at_work ends trigger');
      }
    }

    if (nigthAtWorkChanged) {
      let recalcHeating = false;
      if (this._home_on_next_period) {
        recalcHeating = true;
        this._home_on_next_period = false;
        this._at_home = true;
        await this.homey.app._homeWasSetOnTrigger.trigger(this);
        await this.setCapabilityValue('onoff', true).catch(err => this.log('Error:', err));
        this.log('automatically set home mode');
      }
      if (this._ho_off_next_period) {
        recalcHeating = true;
        this._ho_off_next_period = false;
        this._home_override = false;
        await this.homey.app._homeOverrideSetOffTrigger.trigger(this);
        await this.setCapabilityValue('home_override', false).catch(err => this.log('Error:', err));
        this.log('automatically set home override off');
      }
      if (recalcHeating) {
        calcHeating = heating.calcHeating(localTime, this._at_home, this._home_override, heatingOptions);
        this.log('calcHeating recalc', calcHeating);
      }
    }

    let curHeating = await this.getCapabilityValue('heating');
    let heatChanged = curHeating === undefined || curHeating === null || calcHeating.heating !== curHeating;
    if (heatChanged) {
      await this.setCapabilityValue('heating', calcHeating.heating).catch(err => this.log('Error:', err));
      if (calcHeating.heating) {
        await this.homey.app._comfortModeTrigger.trigger(this);
        this.log('comfortModeTrigger');
      } else {
        await this.homey.app._ecoModeTrigger.trigger(this);
        this.log('ecoModeTrigger');
      }
    }

    const currentPrice = this._getCurrentPrice(this._prices);

    if (currentPrice) {
      const { startsAt, price, priceArea, currency } = currentPrice;
      this.log('currentPrice', startsAt, price);

      let priceChanged = !this._lastPrice || this.toHour(startsAt) !== this.toHour(this._lastPrice);
      if (priceChanged) {
        this._lastPrice = startsAt;
        await this.homey.app._priceChangedTrigger.trigger(this, { price, priceArea, currency });
        const priceCapability = `price_${this.getSetting('currency')}`;
        if (this.hasCapability(priceCapability)) {
          await this.setCapabilityValue(priceCapability, price).catch(err => this.log('Error:', err));
        }
        this.log('price_changed trigger', currentPrice);
      }

      if (priceChanged || heatChanged) {
        await this.homey.app._highPriceTrueTrigger.trigger(this, {
          heating: calcHeating.heating,
          high_price: true
        }, {
          atHome: this._at_home,
          homeOverride: this._home_override,
          heating: calcHeating.heating,
          high_price: true,
          heatingOptions: heatingOptions,
          prices: this._prices
        }).catch(err => this.log('Error:', err));

        await this.homey.app._highPriceFalseTrigger.trigger(this, {
          heating: calcHeating.heating,
          high_price: false
        }, {
          atHome: this._at_home,
          homeOverride: this._home_override,
          heating: calcHeating.heating,
          high_price: false,
          heatingOptions: heatingOptions,
          prices: this._prices
        }).catch(err => this.log('Error:', err));

        await this.homey.app._lowPriceTrueTrigger.trigger(this, {
          heating: calcHeating.heating,
          low_price: true
        }, {
          atHome: this._at_home,
          homeOverride: this._home_override,
          heating: calcHeating.heating,
          low_price: true,
          heatingOptions: heatingOptions,
          prices: this._prices
        }).catch(err => this.log('Error:', err));

        await this.homey.app._lowPriceFalseTrigger.trigger(this, {
          heating: calcHeating.heating,
          low_price: false
        }, {
          atHome: this._at_home,
          homeOverride: this._home_override,
          heating: calcHeating.heating,
          low_price: false,
          heatingOptions: heatingOptions,
          prices: this._prices
        }).catch(err => this.log('Error:', err));
      }
    }
  }

  _getCurrentPrice(prices) {
    const currentHour = this.toHour(dayjs().tz());
    return prices.find(p => this.toHour(p.startsAt) === currentHour);
  }

  _heatingOffHighPriceComparer(args, state) {
    if (!args.high_hours
      || args.high_hours <= 0
      || args.high_hours >= 24
      || !state.prices) {
      return false;
    }

    const localTime = dayjs().tz();

    // Finds prices starting at 00:00 today
    let pricesNextHours = pricesLib.pricesStarting(state.prices, localTime, 0, 24);
    if (pricesNextHours.length === 0) {
      return false;
    }

    // Check if high price now.  Must be ECO mode, and will skip consecutive hours.
    let highPriceNow = pricesLib.checkHighPrice2(pricesNextHours, args.high_hours, localTime, state);

    return state.high_price === false && highPriceNow.size() === 0 || state.high_price === true && highPriceNow.size() === 1;
  }

  _highHoursComparer(args, state) {
    if (!args.high_hours
      || args.high_hours <= 0
      || args.high_hours >= 24
      || !state.prices) {
      return false;
    }

    const localTime = dayjs().tz();

    // Finds prices starting at 00:00 today
    let pricesNextHours = pricesLib.pricesStarting(state.prices, localTime, 0, 24);
    if (pricesNextHours.length === 0) {
      return false;
    }

    // Check if high price now.
    let highPriceNow = pricesLib.checkHighPrice(pricesNextHours, args.high_hours, localTime);

    return state.high_price === false && highPriceNow.size() === 0 || state.high_price === true && highPriceNow.size() === 1;
  }

  _lowHoursComparer(args, state) {
    if (!args.low_hours
      || args.low_hours <= 0
      || args.low_hours >= 24
      || !state.prices) {
      return false;
    }

    const localTime = dayjs().tz();

    // Finds prices starting at 00:00 today
    let pricesNextHours = pricesLib.pricesStarting(state.prices, localTime, 0, 24);
    if (pricesNextHours.length === 0) {
      return false;
    }

    // Check if low price now
    let lowPriceNow = pricesLib.checkLowPrice(pricesNextHours, args.low_hours, localTime);

    return state.low_price === true && lowPriceNow.size() === 1 || state.low_price === false && lowPriceNow.size() === 0;
  }

  _priceAvgComparer(args, state) {
    if (!args.percentage
      || args.percentage <= 0
      || args.percentage >= 100
      || !state.prices
      || !state.currentPrice) {
      return false;
    }
    const localTime = dayjs().tz();
    let startHour = 0;
    let numHours = 24;
    if (args.hours) {
      startHour = localTime.hour();
      numHours = args.hours;
    }

    // Finds average of prices
    const averagePrice = pricesLib.averagePricesStarting(state.prices, localTime, startHour, numHours);
    if (!averagePrice) {
      return false;
    }

    return pricesLib.checkAveragePrice(state.currentPrice.price, averagePrice, state.below, args.percentage);
  }

  _priceAmongLowestComparer(args, state) {
    if (!args.low_hours
      || args.low_hours <= 0
      || args.low_hours >= 24
      || !state.prices) {
      return false;
    }

    const localTime = dayjs().tz();
    let startHour = 0;
    let numHours = 24;
    let numLowestHours = 1;
    if (args.hours) {
      startHour = localTime.hour();
      numHours = args.hours;
      numLowestHours = args.low_hours;
    }

    return pricesLib.pricesAmongLowest(state.prices, localTime, startHour, numHours, numLowestHours);
  }

  _priceAmongHighestComparer(args, state) {
    if (!args.high_hours
      || args.high_hours <= 0
      || args.high_hours >= 24
      || !state.prices) {
      return false;
    }

    const localTime = dayjs().tz();
    let startHour = 0;
    let numHours = 24;
    let numHighestHours = 1;
    if (args.hours) {
      startHour = localTime.hour();
      numHours = args.hours;
      numHighestHours = args.high_hours;
    }

    return pricesLib.pricesAmongHighest(state.prices, localTime, startHour, numHours, numHighestHours);
  }

  _getHeatingOptions() {
    const settings = this.getSettings();
    return {
      workday: {
        startHour: settings.workdayStartHour || 5,
        endHour: settings.workdayEndHour || 22.5,
      },
      notWorkday: {
        startHour: settings.notWorkdayStartHour || 7,
        endHour: settings.notWorkdayEndHour || 23,
      },
      workHours: {
        startHour: settings.workHoursStartHour || 7,
        endHour: settings.workHoursEndHour || 14
      },
      country: settings.country,
      holiday_today: settings.holiday_today
    };
  }

};
