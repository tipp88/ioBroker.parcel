// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Load the real adapter methods without starting an ioBroker process or loading
// unrelated provider dependencies. All network and state I/O is supplied below.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const context = {
  require: (id) => id === 'crypto' ? require('node:crypto') : { Adapter: class {}, default: {} },
  module: { exports: {} },
};
vm.runInNewContext(source + '\nmodule.exports = Parcel.prototype;', context);
const prototype = context.module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (accepted, rejected = []) => ({ data: { code: 0, data: { accepted, rejected } } });

function fixture(handler) {
  const states = { '17t.trackList': JSON.stringify(['LAST']) };
  const calls = [];
  const adapter = Object.assign(Object.create(prototype), {
    config: { '17trackKey': 'test-key' },
    sessions: { '17track': 'test-key' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    logAxiosError: (_label, error) => { throw error; },
    sleep: async () => {},
    requestClient: async (options) => {
      const command = options.url.split('/').pop();
      const data = JSON.parse(options.data);
      calls.push({ command, data });
      return handler(command, data);
    },
    setStateAsync: async (id, value) => { states[id] = value; },
    setState: (id, value) => { states[id] = value; },
    ignoredPath: [],
    json2iob: { parse() {} },
    cleanupProvider: async () => {},
    delivery_status: { OUT_FOR_DELIVERY: 40, DELIVERED: 1 },
    deliveryStatusCheck: () => 30,
  });
  return { adapter, states, calls };
}

describe('17TRACK API shipments', () => {
  it('recovers the complete paginated list and publishes every batch and shipment key', async () => {
    const numbers = Array.from({ length: 45 }, (_, i) => 'TRACK' + i);
    const { adapter, states, calls } = fixture((command, data) => {
      if (command === 'gettracklist') {
        assert.deepEqual(Object.keys(data), ['page_no']);
        const page = data.page_no === 1 ? numbers.slice(0, 30) : data.page_no === 2 ? numbers.slice(30) : [];
        return response(page.map((number) => ({ number })));
      }
      assert.equal(command, 'gettrackinfo');
      assert.ok(data.length <= 40);
      return response(data.map(({ number }) => ({ number, track: { z0: { z: 'In transit' } } })));
    });
    await adapter.updateProvider();
    assert.deepEqual(JSON.parse(states['17t.trackList']), numbers);
    assert.deepEqual(calls.filter((call) => call.command === 'gettrackinfo').map((call) => call.data.length), [40, 5]);
    assert.deepEqual(Object.keys(JSON.parse(states.allProviderObjects)), numbers);
    assert.equal(JSON.parse(states.allProviderJson).length, 45);
    assert.equal(JSON.parse(states['17t.trackinginfo.json']).accepted.length, 45);
    assert.equal(states.notDeliveredCount, 45);
  });

  for (const command of ['register', 'deleteTrack']) {
    it(command + ' refreshes all numbers without filtering to the changed shipment', async () => {
      const { adapter, states } = fixture((endpoint, data) => {
        if (endpoint === command) return response([{ number: 'LAST' }]);
        assert.equal(endpoint, 'gettracklist');
        assert.deepEqual(Object.keys(data), ['page_no']);
        return response(data.page_no === 1 ? [{ number: 'FIRST' }, { number: 'SECOND' }] : []);
      });
      await adapter.onStateChange('parcel.0.17t.' + command, { val: 'LAST', ack: false });
      assert.deepEqual(JSON.parse(states['17t.trackList']), ['FIRST', 'SECOND']);
    });
  }

  it('clears an empty account without sending an empty gettrackinfo request', async () => {
    const { adapter, states, calls } = fixture(() => response([]));
    assert.deepEqual(plain(await adapter.fetch17TParcels()), { accepted: [], rejected: [] });
    assert.equal(states['17t.trackList'], '[]');
    assert.equal(calls.length, 1);
  });

  it('keeps the saved list if a later page fails', async () => {
    const { adapter, states } = fixture((_command, data) => data.page_no === 1
      ? response([{ number: 'FIRST' }]) : { data: { code: -18010002 } });
    await assert.rejects(adapter.refresh17TTrackList(), /gettracklist failed/);
    assert.equal(states['17t.trackList'], '["LAST"]');
  });

  it('publishes all collected shipments when the API repeats its last page', async () => {
    const { adapter, states, calls } = fixture((command, data) => {
      if (command === 'gettracklist') {
        return response(data.page_no === 1 ? [{ number: 'FIRST' }] : [{ number: 'SECOND' }]);
      }
      return response(data.map(({ number }) => ({ number, track: { z0: { z: 'In transit' } } })));
    });
    await adapter.updateProvider();
    assert.deepEqual(JSON.parse(states['17t.trackList']), ['FIRST', 'SECOND']);
    assert.deepEqual(Object.keys(JSON.parse(states.allProviderObjects)), ['FIRST', 'SECOND']);
    assert.equal(states.notDeliveredCount, 2);
    assert.equal(calls.filter((call) => call.command === 'gettracklist').length, 3);
  });

  it('recognizes repeated shipments despite changed metadata and response order', async () => {
    const { adapter, calls } = fixture((_command, data) => response(data.page_no === 1
      ? [{ number: 'FIRST', w1: 1, tt: 'old' }, { number: 'SECOND', w1: 2 }]
      : [{ number: 'SECOND', w1: 2 }, { number: 'FIRST', w1: 1, tt: 'new' }]));
    assert.deepEqual(plain(await adapter.refresh17TTrackList()), ['FIRST', 'SECOND']);
    assert.equal(calls.length, 2);
  });

  it('stops at the reported last page without requesting an extra page', async () => {
    const { adapter, calls } = fixture((_command, data) => ({
      ...response([{ number: 'TRACK' + data.page_no }]),
      data: {
        ...response([{ number: 'TRACK' + data.page_no }]).data,
        page: { page_no: data.page_no, page_total: 2 },
      },
    }));
    assert.deepEqual(plain(await adapter.refresh17TTrackList()), ['TRACK1', 'TRACK2']);
    assert.equal(calls.length, 2);
  });

  it('combines accepted and rejected results across detail batches', async () => {
    const { adapter } = fixture((_command, data) => response(data.slice(0, -1), data.slice(-1)));
    adapter.refresh17TTrackList = async () => Array.from({ length: 41 }, (_, i) => 'TRACK' + i);
    const result = await adapter.fetch17TParcels();
    assert.equal(result.accepted.length, 39);
    assert.deepEqual(plain(result.rejected), [{ number: 'TRACK39' }, { number: 'TRACK40' }]);
  });
});
