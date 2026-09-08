import Flatbush from './index.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Unchanged search method from v4.6.2, commit 4df50c9b.
function referenceSearch(minX, minY, maxX, maxY, filterFn) {
        if (this._pos !== this._boxes.length) {
            throw new Error('Data not yet indexed - call index.finish().');
        }
        const {_boxes: boxes, _levelBounds: levelBounds, _indices: indices, nodeSize} = this;
        const numItems4 = this.numItems * 4;

        /** @type number | undefined */
        let nodeIndex = boxes.length - 4;
        let level = levelBounds.length - 1; // start at the root level
        const q = [];
        const results = [];

        let contained = false; // whether the current node's bbox is fully inside the query

        while (nodeIndex !== undefined) {
            // find the end index of the node, capped at the level boundary
            const end = Math.min(nodeIndex + nodeSize * 4, levelBounds[level]);
            const isNode = nodeIndex >= numItems4;

            if (contained) {
                this._collectContained(nodeIndex, end, level, numItems4, results, filterFn);

            } else {
                // search through child nodes
                for (let /** @type {number} */ pos = nodeIndex; pos < end; pos += 4) {
                    // check if node bbox intersects with query bbox
                    const x0 = boxes[pos];
                    if (maxX < x0) continue;
                    const y0 = boxes[pos + 1];
                    if (maxY < y0) continue;
                    const x1 = boxes[pos + 2];
                    if (minX > x1) continue;
                    const y1 = boxes[pos + 3];
                    if (minY > y1) continue;

                    const index = indices[pos >> 2] | 0;

                    if (isNode) {
                        // node intersects; flag it as contained if its bbox is fully inside the query
                        const c = +(minX <= x0 && minY <= y0 && maxX >= x1 && maxY >= y1);
                        q.push(index | c, level - 1); // node; add it and its level to the search queue

                    } else if (filterFn === undefined || filterFn(index, x0, y0, x1, y1)) {
                        results.push(index); // leaf item
                    }
                }
            }

            level = /** @type {number} */ (q.pop());
            nodeIndex = q.pop();
            if (nodeIndex !== undefined) {
                contained = (nodeIndex & 1) === 1;
                nodeIndex &= ~1;
            }
        }

        return results;
    }


function makeIndex(count, nodeSize = 16, ArrayType = Float64Array) {
    const index = new Flatbush(count, nodeSize, ArrayType);
    for (let i = 0; i < count; i++) {
        const x = i * 31 % 217 - 100;
        const y = i * 17 % 193 - 90;
        index.add(x, y, x + i % 7, y + i % 11);
    }
    index.finish();
    return index;
}

test('root rejection preserves exact result and filter order across packed trees and numeric bounds', () => {
    const queries = [
        [-Infinity, -Infinity, Infinity, Infinity],
        [-1000, -1000, -999, -999], [1000, 1000, 1001, 1001],
        [-100, -90, -100, -90], [-101, -91, -100, -90],
        [NaN, -Infinity, Infinity, Infinity], [-Infinity, NaN, Infinity, Infinity],
        [-Infinity, -Infinity, NaN, Infinity], [-Infinity, -Infinity, Infinity, NaN],
        [NaN, NaN, NaN, NaN], [0, -0, 0, -0], [1, 1, -1, -1],
        [0n, 0n, 1n, 1n], ["-100", "-90", "0", "0"],
        [-Number.MIN_VALUE, -Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE],
        [-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]
    ];
    let seed = 94173;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    for (let i = 0; i < 200; i++) {
        const x = random() * 500 - 250;
        const y = random() * 500 - 250;
        queries.push([x, y, x + random() * 100, y + random() * 100]);
    }
    for (const count of [1, 2, 15, 16, 17, 255, 300]) {
        for (const nodeSize of [2, 16, 255]) {
            for (const ArrayType of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array,
                Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) {
                const index = makeIndex(count, nodeSize, ArrayType);
                const restored = Flatbush.from(index.data.slice(0));
                for (const query of queries) {
                    const referenceCalls = [];
                    const candidateCalls = [];
                    const expected = referenceSearch.call(index, ...query, (...args) => {
                        referenceCalls.push(args);
                        return args[0] % 3 !== 0;
                    });
                    const actual = restored.search(...query, (...args) => {
                        candidateCalls.push(args);
                        return args[0] % 3 !== 0;
                    });
                    assert.deepEqual(actual, expected);
                    assert.deepEqual(candidateCalls, referenceCalls);
                    assert.deepEqual(restored.search(...query), referenceSearch.call(index, ...query));
                }
            }
        }
    }
});

test('root search preserves field reads, query coercion, contained callbacks and finished checks', () => {
    function run(search, mode) {
        const index = makeIndex(37, 4);
        const reads = [];
        for (const name of ['_boxes', '_indices', '_levelBounds']) {
            const original = index[name];
            const tracked = new Proxy(original, {
                get(target, key) {
                    reads.push(`${name}[${String(key)}]`);
                    return Reflect.get(target, key, target);
                }
            });
            Object.defineProperty(index, name, {get() { reads.push(name); return tracked; }});
        }
        for (const name of ['_pos', 'nodeSize', 'numItems']) {
            const value = index[name];
            Object.defineProperty(index, name, {get() { reads.push(name); return value; }});
        }
        for (const name of ['minX', 'minY', 'maxX', 'maxY']) {
            Object.defineProperty(index, name, {get() { throw new Error(`Unexpected public ${name} read`); }});
        }
        const collect = index._collectContained;
        index._collectContained = function (...args) {
            reads.push(`collect:${args.slice(0, 4).join(',')}`);
            return collect.apply(this, args);
        };
        let coercions = 0;
        const query = (mode === 'miss' ? [1000, 1000, 1001, 1001] : [-100, -90, 117, 113]).map((value, i) => ({
            valueOf() {
                reads.push(`query${i}`);
                return mode === 'mutable' ? value + (coercions++ % 3) : value;
            }
        }));
        const result = search.call(index, ...query, (...args) => {
            reads.push(`filter:${args.join(',')}`);
            return args[0] % 2 === 0;
        });
        return {result, reads};
    }
    for (const mode of ['miss', 'contained', 'mutable']) {
        assert.deepEqual(run(Flatbush.prototype.search, mode), run(referenceSearch, mode));
    }
    const unfinished = new Flatbush(1);
    unfinished.add(0, 0, 1, 1);
    assert.throws(() => unfinished.search(100, 100, 101, 101), /Data not yet indexed/);
    const index = makeIndex(17);
    let called = false;
    const miss = index.search(1000, 1000, 1001, 1001, () => { called = true; throw new Error('filter'); });
    assert.deepEqual(miss, []);
    assert.equal(called, false);
    assert.notEqual(miss, index.search(1000, 1000, 1001, 1001));
    assert.throws(() => index.search(-Infinity, -Infinity, Infinity, Infinity, () => { throw new Error('filter'); }), /filter/);
});

test('root rejection uses stored buffer bounds and preserves unusual indexed coordinates', () => {
    for (const rectangles of [
        [[0, 0, 1, 1]],
        [[NaN, 0, 1, 1], [-1, -1, 2, 2]],
        [[-Infinity, -Infinity, Infinity, Infinity]],
        [[5, 5, -5, -5], [0, 0, 0, 0]],
        [[-0, 0, -0, 0]]
    ]) {
        const index = new Flatbush(rectangles.length, 2);
        for (const rectangle of rectangles) index.add(...rectangle);
        index.finish();
        index.minX = index.minY = 1000;
        index.maxX = index.maxY = -1000;
        for (const query of [[-1, -1, 1, 1], [0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 3, 3], [NaN, NaN, NaN, NaN]]) {
            assert.deepEqual(index.search(...query), referenceSearch.call(index, ...query));
        }
        const buffer = new SharedArrayBuffer(index.data.byteLength + 8);
        new Uint8Array(buffer, 8).set(new Uint8Array(index.data));
        const restored = Flatbush.from(buffer, 8);
        assert.deepEqual(restored.search(0, 0, 1, 1), referenceSearch.call(restored, 0, 0, 1, 1));
    }
});
