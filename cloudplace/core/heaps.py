"""Addressable priority queues with decrease-key.

All heaps share one interface so Dijkstra / Prim can switch implementations:

    push(item, key)          insert a new item
    pop() -> (item, key)     remove and return the minimum
    decrease_key(item, key)  lower the key of an item already in the heap
    item in heap, len(heap), peek()

==================  ==========  ==========  ============  =============
operation           BinaryHeap  FibHeap     PairingHeap   LazyHeap
==================  ==========  ==========  ============  =============
push                O(log n)    O(1)        O(1)          O(log n)
pop (extract-min)   O(log n)    O(log n)*   O(log n)*     O(log m)*
decrease_key        O(log n)    O(1)*       o(log n)*     O(log m)
==================  ==========  ==========  ============  =============
(* amortised; LazyHeap stores stale duplicates, m = number of pushes)

With these bounds Dijkstra / Prim run in O((V + E) log V) with the binary heap
and O(E + V log V) with the Fibonacci heap.
"""
from __future__ import annotations

import heapq
import math
from typing import Any, Hashable


class EmptyHeapError(IndexError):
    pass


# ------------------------------------------------------------------ binary
class BinaryHeap:
    """Array-backed binary min-heap with a position map for O(log n) decrease-key."""

    name = "binary"

    def __init__(self) -> None:
        self._keys: list[float] = []
        self._items: list[Hashable] = []
        self._pos: dict[Hashable, int] = {}

    def __len__(self) -> int:
        return len(self._items)

    def __contains__(self, item: Hashable) -> bool:
        return item in self._pos

    def key(self, item: Hashable) -> float:
        return self._keys[self._pos[item]]

    def peek(self) -> tuple[Hashable, float]:
        if not self._items:
            raise EmptyHeapError("peek from empty heap")
        return self._items[0], self._keys[0]

    def push(self, item: Hashable, key: float) -> None:
        if item in self._pos:
            raise KeyError(f"{item!r} already in heap")
        self._items.append(item)
        self._keys.append(key)
        self._pos[item] = len(self._items) - 1
        self._sift_up(len(self._items) - 1)

    def pop(self) -> tuple[Hashable, float]:
        if not self._items:
            raise EmptyHeapError("pop from empty heap")
        top_item, top_key = self._items[0], self._keys[0]
        last = len(self._items) - 1
        self._swap(0, last)
        self._items.pop()
        self._keys.pop()
        del self._pos[top_item]
        if self._items:
            self._sift_down(0)
        return top_item, top_key

    def decrease_key(self, item: Hashable, key: float) -> None:
        i = self._pos[item]
        if key > self._keys[i]:
            raise ValueError("new key is larger than current key")
        self._keys[i] = key
        self._sift_up(i)

    def push_or_decrease(self, item: Hashable, key: float) -> bool:
        """Insert, or lower the key if smaller. Returns True if the heap changed."""
        if item in self._pos:
            if key < self._keys[self._pos[item]]:
                self.decrease_key(item, key)
                return True
            return False
        self.push(item, key)
        return True

    # internals
    def _swap(self, i: int, j: int) -> None:
        it, ks = self._items, self._keys
        it[i], it[j] = it[j], it[i]
        ks[i], ks[j] = ks[j], ks[i]
        self._pos[it[i]] = i
        self._pos[it[j]] = j

    def _sift_up(self, i: int) -> None:
        ks = self._keys
        while i > 0:
            p = (i - 1) >> 1
            if ks[i] < ks[p]:
                self._swap(i, p)
                i = p
            else:
                break

    def _sift_down(self, i: int) -> None:
        ks = self._keys
        n = len(ks)
        while True:
            l = 2 * i + 1
            r = l + 1
            s = i
            if l < n and ks[l] < ks[s]:
                s = l
            if r < n and ks[r] < ks[s]:
                s = r
            if s == i:
                return
            self._swap(i, s)
            i = s


# --------------------------------------------------------------- fibonacci
class _FibNode:
    __slots__ = ("item", "key", "parent", "child", "left", "right", "degree", "mark")

    def __init__(self, item: Hashable, key: float) -> None:
        self.item = item
        self.key = key
        self.parent: _FibNode | None = None
        self.child: _FibNode | None = None
        self.left: _FibNode = self
        self.right: _FibNode = self
        self.degree = 0
        self.mark = False


class FibonacciHeap:
    """Fibonacci heap (Fredman & Tarjan 1987) with cascading cuts."""

    name = "fibonacci"

    def __init__(self) -> None:
        self._min: _FibNode | None = None
        self._n = 0
        self._nodes: dict[Hashable, _FibNode] = {}

    def __len__(self) -> int:
        return self._n

    def __contains__(self, item: Hashable) -> bool:
        return item in self._nodes

    def key(self, item: Hashable) -> float:
        return self._nodes[item].key

    def peek(self) -> tuple[Hashable, float]:
        if self._min is None:
            raise EmptyHeapError("peek from empty heap")
        return self._min.item, self._min.key

    @staticmethod
    def _splice(a: _FibNode, b: _FibNode) -> None:
        """Insert single node b to the right of a in a's circular list."""
        b.left = a
        b.right = a.right
        a.right.left = b
        a.right = b

    @staticmethod
    def _unlink(x: _FibNode) -> None:
        x.left.right = x.right
        x.right.left = x.left
        x.left = x.right = x

    def push(self, item: Hashable, key: float) -> None:
        if item in self._nodes:
            raise KeyError(f"{item!r} already in heap")
        x = _FibNode(item, key)
        self._nodes[item] = x
        if self._min is None:
            self._min = x
        else:
            self._splice(self._min, x)
            if key < self._min.key:
                self._min = x
        self._n += 1

    def pop(self) -> tuple[Hashable, float]:
        z = self._min
        if z is None:
            raise EmptyHeapError("pop from empty heap")
        # move z's children to the root list
        if z.child is not None:
            children = []
            c = z.child
            while True:
                children.append(c)
                c = c.right
                if c is z.child:
                    break
            for c in children:
                self._unlink(c)
                c.parent = None
                self._splice(z, c)
            z.child = None
        if z.right is z:
            self._min = None
        else:
            self._min = z.right
            self._unlink(z)
            self._consolidate()
        self._n -= 1
        del self._nodes[z.item]
        return z.item, z.key

    def _consolidate(self) -> None:
        assert self._min is not None
        max_deg = int(math.log(max(self._n, 1), (1 + 5 ** 0.5) / 2)) + 2
        A: list[_FibNode | None] = [None] * (max_deg + 1)
        roots = []
        w = self._min
        while True:
            roots.append(w)
            w = w.right
            if w is self._min:
                break
        for w in roots:
            x = w
            d = x.degree
            while True:
                if d >= len(A):
                    A.extend([None] * (d - len(A) + 1))
                y = A[d]
                if y is None:
                    break
                if y.key < x.key:
                    x, y = y, x
                self._link(y, x)
                A[d] = None
                d += 1
            if d >= len(A):
                A.extend([None] * (d - len(A) + 1))
            A[d] = x
        self._min = None
        for x in A:
            if x is None:
                continue
            x.left = x.right = x
            if self._min is None:
                self._min = x
            else:
                self._splice(self._min, x)
                if x.key < self._min.key:
                    self._min = x

    def _link(self, y: _FibNode, x: _FibNode) -> None:
        """Make root y a child of root x."""
        self._unlink(y)
        y.parent = x
        if x.child is None:
            x.child = y
        else:
            self._splice(x.child, y)
        x.degree += 1
        y.mark = False

    def decrease_key(self, item: Hashable, key: float) -> None:
        x = self._nodes[item]
        if key > x.key:
            raise ValueError("new key is larger than current key")
        x.key = key
        y = x.parent
        if y is not None and x.key < y.key:
            self._cut(x, y)
            self._cascading_cut(y)
        assert self._min is not None
        if x.key < self._min.key:
            self._min = x

    def _cut(self, x: _FibNode, y: _FibNode) -> None:
        if y.child is x:
            y.child = x.right if x.right is not x else None
        self._unlink(x)
        y.degree -= 1
        assert self._min is not None
        self._splice(self._min, x)
        x.parent = None
        x.mark = False

    def _cascading_cut(self, y: _FibNode) -> None:
        z = y.parent
        while z is not None:
            if not y.mark:
                y.mark = True
                return
            self._cut(y, z)
            y = z
            z = y.parent

    def push_or_decrease(self, item: Hashable, key: float) -> bool:
        if item in self._nodes:
            if key < self._nodes[item].key:
                self.decrease_key(item, key)
                return True
            return False
        self.push(item, key)
        return True


# ------------------------------------------------------------------ pairing
class _PairNode:
    __slots__ = ("item", "key", "child", "sibling", "prev")

    def __init__(self, item: Hashable, key: float) -> None:
        self.item = item
        self.key = key
        self.child: _PairNode | None = None
        self.sibling: _PairNode | None = None
        self.prev: _PairNode | None = None  # parent if leftmost child, else left sibling


class PairingHeap:
    """Pairing heap (two-pass). Simple, and fast in practice."""

    name = "pairing"

    def __init__(self) -> None:
        self._root: _PairNode | None = None
        self._nodes: dict[Hashable, _PairNode] = {}

    def __len__(self) -> int:
        return len(self._nodes)

    def __contains__(self, item: Hashable) -> bool:
        return item in self._nodes

    def key(self, item: Hashable) -> float:
        return self._nodes[item].key

    def peek(self) -> tuple[Hashable, float]:
        if self._root is None:
            raise EmptyHeapError("peek from empty heap")
        return self._root.item, self._root.key

    @staticmethod
    def _meld(a: _PairNode | None, b: _PairNode | None) -> _PairNode | None:
        if a is None:
            return b
        if b is None:
            return a
        if b.key < a.key:
            a, b = b, a
        # b becomes leftmost child of a
        b.prev = a
        b.sibling = a.child
        if a.child is not None:
            a.child.prev = b
        a.child = b
        a.sibling = None
        a.prev = None
        return a

    def push(self, item: Hashable, key: float) -> None:
        if item in self._nodes:
            raise KeyError(f"{item!r} already in heap")
        x = _PairNode(item, key)
        self._nodes[item] = x
        self._root = self._meld(self._root, x)

    def _merge_pairs(self, first: _PairNode | None) -> _PairNode | None:
        pairs: list[_PairNode] = []
        cur = first
        while cur is not None:
            a = cur
            b = cur.sibling
            nxt = b.sibling if b is not None else None
            a.sibling = a.prev = None
            if b is not None:
                b.sibling = b.prev = None
            m = self._meld(a, b)
            assert m is not None
            pairs.append(m)
            cur = nxt
        res: _PairNode | None = None
        for p in reversed(pairs):
            res = self._meld(p, res)
        return res

    def pop(self) -> tuple[Hashable, float]:
        r = self._root
        if r is None:
            raise EmptyHeapError("pop from empty heap")
        self._root = self._merge_pairs(r.child)
        del self._nodes[r.item]
        return r.item, r.key

    def decrease_key(self, item: Hashable, key: float) -> None:
        x = self._nodes[item]
        if key > x.key:
            raise ValueError("new key is larger than current key")
        x.key = key
        if x is self._root:
            return
        # detach x's subtree
        if x.prev is not None:
            if x.prev.child is x:
                x.prev.child = x.sibling
            else:
                x.prev.sibling = x.sibling
        if x.sibling is not None:
            x.sibling.prev = x.prev
        x.sibling = x.prev = None
        self._root = self._meld(self._root, x)

    def push_or_decrease(self, item: Hashable, key: float) -> bool:
        if item in self._nodes:
            if key < self._nodes[item].key:
                self.decrease_key(item, key)
                return True
            return False
        self.push(item, key)
        return True


# --------------------------------------------------------------------- lazy
class LazyHeap:
    """Wrapper over stdlib heapq using lazy deletion (no true decrease-key).

    Included as the practical baseline: C-implemented heapq usually wins in
    CPython despite the worse asymptotic bound on the number of entries.
    """

    name = "lazy"

    def __init__(self) -> None:
        self._h: list[tuple[float, int, Hashable]] = []
        self._best: dict[Hashable, float] = {}
        self._counter = 0

    def __len__(self) -> int:
        return len(self._best)

    def __contains__(self, item: Hashable) -> bool:
        return item in self._best

    def key(self, item: Hashable) -> float:
        return self._best[item]

    def _clean(self) -> None:
        h = self._h
        while h and self._best.get(h[0][2]) != h[0][0]:
            heapq.heappop(h)

    def peek(self) -> tuple[Hashable, float]:
        self._clean()
        if not self._h:
            raise EmptyHeapError("peek from empty heap")
        k, _, it = self._h[0]
        return it, k

    def push(self, item: Hashable, key: float) -> None:
        if item in self._best:
            raise KeyError(f"{item!r} already in heap")
        self._best[item] = key
        self._counter += 1
        heapq.heappush(self._h, (key, self._counter, item))

    def pop(self) -> tuple[Hashable, float]:
        self._clean()
        if not self._h:
            raise EmptyHeapError("pop from empty heap")
        k, _, it = heapq.heappop(self._h)
        del self._best[it]
        return it, k

    def decrease_key(self, item: Hashable, key: float) -> None:
        if key > self._best[item]:
            raise ValueError("new key is larger than current key")
        self._best[item] = key
        self._counter += 1
        heapq.heappush(self._h, (key, self._counter, item))

    def push_or_decrease(self, item: Hashable, key: float) -> bool:
        if item in self._best:
            if key < self._best[item]:
                self.decrease_key(item, key)
                return True
            return False
        self.push(item, key)
        return True


HEAPS: dict[str, type] = {
    "binary": BinaryHeap,
    "fibonacci": FibonacciHeap,
    "pairing": PairingHeap,
    "lazy": LazyHeap,
}


def make_heap(kind: str = "binary") -> Any:
    try:
        return HEAPS[kind]()
    except KeyError:
        raise ValueError(f"unknown heap '{kind}', choose from {sorted(HEAPS)}") from None
