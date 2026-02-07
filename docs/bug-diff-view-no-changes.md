# Diff View "No Changes" Flash Bug

## 症状

Diff View で一瞬「No Changes」が表示されてから正しい diff が描画される。

**再現シナリオ：**
1. ファイル A の diff を表示中
2. ファイル B に切り替え
3. 一瞬「No Changes」→ 正しい diff が表示

## 根本原因

`useSubscription` で `cancelledRef` が全 subscribe 呼び出しで共有されている。新しい subscribe 開始時に `cancelledRef = false` へリセットされるため、進行中の古い subscribe がキャンセルを検知できず、stale なデータで状態を更新してしまう。

```
Timeline:
┌─────────────────────────────────────────────────────────────────┐
│ t0: subscribe(A) 開始                                           │
│ t1: subscribe(B) 開始 → cancelledRef = false にリセット          │
│ t2: subscribe(A) 完了 → cancelledRef は false なので処理続行！    │
│     → onSubscribed(A の initial) が呼ばれる                      │
│     → Diff View が A のデータ（空 or 古い）で更新される            │
│ t3: subscribe(B) 完了 → 正しいデータで更新                       │
└─────────────────────────────────────────────────────────────────┘
```

## 問題のコード

**useSubscription.ts:105-106**
```typescript
cancelledRef.current = false;  // ← 全 subscribe のキャンセルフラグをリセット
doSubscribe();                 // ← 非同期、await なし
```

**useSubscription.ts:121-123**（worktree switch でも同様）
```typescript
worktreeActions.onWorktreeSwitchEnd(() => {
    cancelledRef.current = false;  // ← 同じ問題
    doSubscribe();
});
```

## 修正方針

Generation counter パターンで各 subscribe 呼び出しに固有の世代番号を付与し、古い世代の処理を無効化する。

### 設計判断

**Counter パターン vs AbortController：**
- AbortController は signal 伝播が必要で、subscribe 関数のシグネチャ変更が必要
- Counter パターンは既存インターフェースを維持しつつ問題を解決できる
- → Counter パターンを採用

**単一 ref で管理：**
- `cancelledRef` は不要。`generationRef` の increment だけで無効化できる
- `invalidate()` ヘルパーで世代更新と cleanup を一箇所にまとめる

## 修正内容

```typescript
const subscriptionIdRef = useRef<string | null>(null);
const generationRef = useRef(0);

const doSubscribe = useCallback(async () => {
    const generation = ++generationRef.current;
    const isStale = () => generationRef.current !== generation;

    if (subscriptionIdRef.current) {
        await unsubscribe(subscriptionIdRef.current);
        subscriptionIdRef.current = null;
    }

    if (isStale()) return;

    try {
        const result = await subscribe((params) => {
            if (isStale()) return;
            onNotificationRef.current(params);
        });

        if (isStale()) {
            await unsubscribe(result.id);
            return;
        }

        subscriptionIdRef.current = result.id;
        if ("initial" in result && onSubscribedRef.current) {
            onSubscribedRef.current(result.initial as TInitial);
        }
    } catch (err) {
        console.error("Subscription failed:", err);
        if (!isStale()) {
            onResetRef.current?.();
        }
    }
}, [subscribe, unsubscribe]);

const invalidate = useCallback(() => {
    generationRef.current++;
    if (subscriptionIdRef.current) {
        unsubscribe(subscriptionIdRef.current);
        subscriptionIdRef.current = null;
    }
}, [unsubscribe]);

useEffect(() => {
    if (!enabled || !isConnected) {
        invalidate();
        onResetRef.current?.();
        return;
    }

    doSubscribe();

    const cleanupSwitchStart = resubscribeOnWorktreeChange
        ? worktreeActions.onWorktreeSwitchStart(() => {
                invalidate();
                onResetRef.current?.();
            })
        : undefined;

    const cleanupSwitchEnd = resubscribeOnWorktreeChange
        ? worktreeActions.onWorktreeSwitchEnd(doSubscribe)
        : undefined;

    return () => {
        cleanupSwitchStart?.();
        cleanupSwitchEnd?.();
        invalidate();
    };
}, [enabled, isConnected, doSubscribe, invalidate, resubscribeOnWorktreeChange]);
```

## テスト追加

既存の `useSubscription.test.ts` に race condition テストを追加：

```typescript
describe("race condition handling", () => {
    // 既存テスト...

    it("ignores stale subscription when new subscribe starts before old completes", async () => {
        let resolveFirst: (result: { id: string; initial: string }) => void;
        let resolveSecond: (result: { id: string; initial: string }) => void;

        mockSubscribe
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveFirst = resolve;
                })
            )
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveSecond = resolve;
                })
            );

        const onSubscribed = vi.fn();
        const { result } = renderHook(() =>
            useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
                onSubscribed,
            })
        );

        // First subscribe starts
        expect(mockSubscribe).toHaveBeenCalledTimes(1);

        // Trigger second subscribe via refresh before first completes
        await act(async () => {
            result.current.refresh();
        });

        expect(mockSubscribe).toHaveBeenCalledTimes(2);

        // First subscribe completes (now stale)
        await act(async () => {
            resolveFirst!({ id: "sub-1", initial: "stale-data" });
        });

        // Stale subscription should be unsubscribed, onSubscribed should NOT be called
        expect(mockUnsubscribe).toHaveBeenCalledWith("sub-1");
        expect(onSubscribed).not.toHaveBeenCalled();

        // Second subscribe completes
        await act(async () => {
            resolveSecond!({ id: "sub-2", initial: "fresh-data" });
        });

        // Only fresh data should trigger onSubscribed
        expect(onSubscribed).toHaveBeenCalledTimes(1);
        expect(onSubscribed).toHaveBeenCalledWith("fresh-data");
    });

    it("ignores notification from stale subscription", async () => {
        let capturedCallback: ((params: string) => void) | null = null;
        let resolveFirst: (result: { id: string }) => void;

        mockSubscribe
            .mockImplementationOnce((callback) => {
                capturedCallback = callback;
                return new Promise((resolve) => {
                    resolveFirst = resolve;
                });
            })
            .mockResolvedValueOnce({ id: "sub-2" });

        const { result } = renderHook(() =>
            useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification)
        );

        expect(mockSubscribe).toHaveBeenCalledTimes(1);
        const staleCallback = capturedCallback;

        // Trigger second subscribe via refresh
        await act(async () => {
            result.current.refresh();
        });

        // First subscribe completes after second started
        await act(async () => {
            resolveFirst!({ id: "sub-1" });
        });

        // Call the stale callback
        act(() => {
            staleCallback?.("stale-notification");
        });

        // Notification should be ignored
        expect(mockOnNotification).not.toHaveBeenCalled();
    });
});
```

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `web/src/hooks/useSubscription.ts` | `cancelledRef` を削除、`generationRef` のみで管理、`invalidate()` ヘルパー追加 |
| `web/src/hooks/useSubscription.test.ts` | race condition テストケース追加 |

## 影響範囲

`useSubscription` を使用する全フック（動作改善のみ、破壊的変更なし）：
- `useGitDiffWatch.ts`
- `useFSWatch.ts`
- `useGitWatch.ts`
- `useSessionSubscription.ts`
- `useWorktree.ts`

## 検証手順

1. `pnpm test -- useSubscription` でテスト実行
2. Diff View で素早くファイル切り替えを繰り返し、flash が発生しないことを確認
3. Worktree 切り替え時も同様に確認
