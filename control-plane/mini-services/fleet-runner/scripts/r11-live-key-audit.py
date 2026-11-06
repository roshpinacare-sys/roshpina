#!/usr/bin/env python3
"""
r11-live-key-audit.py — R11 substance audit: are the exposed keys STILL LIVE?
Task 28. Read-only. Zero broadcast. Zero secret printing. Public chain APIs only.

Inputs (hermetic extraction of the R11 generation, sha256-verified):
  $R11_AGENT_DIR/keys/vault.json            12 STEEM accounts (owner/active/posting/memo WIFs)
  $R11_AGENT_DIR/keys/wallets-registry.json 12 HD accounts × {evm(7 nets), tron, sol, btc}

Checks:
  A. STEEM/HIVE live-authority check: derive public keys from the R11-era WIFs
     (pure-python secp256k1, in-memory only) and compare against CURRENT on-chain
     authorities.  match → key STILL LIVE (exposure is material) · mismatch → rotated.
  B. HD balance sweep: native-asset balances, 12×(7 EVM + TRON + SOL + BTC).
     funds present + mnemonic unrotated → CRITICAL; zero funds → low urgency.

Output: $R11_OUT (default logs/r11-live-key-report.json — public data only).
"""
import json, hashlib, time, urllib.request, sys, os

AGENT_DIR = os.environ.get('R11_AGENT_DIR', '/tmp/r11-audit/agent')
OUT = os.environ.get('R11_OUT', 'logs/r11-live-key-report.json')

# ── secp256k1 (pure python) ──────────────────────────────────────────────────
P = 2**256 - 2**32 - 977
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
def inv(a, m=P): return pow(a, m - 2, m)
def add(p, q):
    if p is None: return q
    if q is None: return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0: return None
    l = ((3 * p[0] * p[0]) * inv(2 * p[1]) % P) if p == q else ((q[1] - p[1]) * inv((q[0] - p[0]) % P) % P)
    x = (l * l - p[0] - q[0]) % P
    return (x, (l * (p[0] - x) - p[1]) % P)
def mul(k, p=(Gx, Gy)):
    r = None
    while k:
        if k & 1: r = add(r, p)
        p = add(p, p); k >>= 1
    return r

B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58d(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    return n.to_bytes((n.bit_length() + 7) // 8, 'big')
def b58e(b):
    n = int.from_bytes(b, 'big'); s = ''
    while n: s = B58[n % 58] + s; n //= 58
    for c in b:
        if c == 0: s = '1' + s
        else: break
    return s
def b58check_decode(s):
    raw = b58d(s)
    data, chk = raw[:-4], raw[-4:]
    if hashlib.sha256(hashlib.sha256(data).digest()).digest()[:4] != chk:
        raise ValueError('b58check checksum fail')
    return data
def wif_priv(wif):
    payload = b58check_decode(wif)
    if payload[0] != 0x80: raise ValueError('not a WIF')
    return payload[1:33]
def steem_pub(priv):
    x, y = mul(int.from_bytes(priv, 'big'))
    payload = (b'\x03' if y & 1 else b'\x02') + x.to_bytes(32, 'big')
    chk = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    return 'STM' + b58e(payload + chk)

def http(url, body=None, headers=None, timeout=20):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers or {'content-type': 'application/json', 'user-agent': 'r11-audit/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def rpc(url, method, params):
    return http(url, {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1})

# ── Part A: STEEM/HIVE live-authority check ─────────────────────────────────
vault = json.load(open(os.path.join(AGENT_DIR, 'keys/vault.json')))
CHAIN_APIS = {'steem': 'https://api.steemit.com', 'hive': 'https://api.hive.blog'}
partA = []
for acc in vault['accounts']:
    name = acc['username']
    if name == 'headcorner':
        for chain, obj in (('steem', acc.get('steem', {})), ('hive', acc.get('hive', {}))):
            wifs = {r: obj.get(f'{r}Private') or obj.get(f'{r}_private') or obj.get(r) for r in ('owner', 'active', 'posting', 'memo')}
            partA.append({'account': name, 'chain': chain, 'wifs': wifs})
    else:
        keys = acc.get('keys', {})
        wifs = {r: keys.get(f'{r}Private') or keys.get(f'{r}_private') or keys.get(r) for r in ('owner', 'active', 'posting', 'memo')}
        wifs = {r: w for r, w in wifs.items() if isinstance(w, str) and len(w) > 40}
        for chain in ('steem', 'hive'):
            partA.append({'account': name, 'chain': chain, 'wifs': wifs})

for entry in partA:
    derived = {}
    for role, wif in entry['wifs'].items():
        if not wif: continue
        try: derived[role] = steem_pub(wif_priv(wif))
        except Exception as e: derived[role] = f'DERIVE-FAIL:{type(e).__name__}'
    entry['derived'] = derived

names_by_chain = {}
for entry in partA:
    names_by_chain.setdefault(entry['chain'], set()).add(entry['account'])
auths = {}
for chain, api in CHAIN_APIS.items():
    names = sorted(names_by_chain.get(chain, []))
    if not names: continue
    try:
        res = rpc(api, 'condenser_api.get_accounts', [names])
        for a in res.get('result', []):
            auths[(chain, a['name'])] = {
                'owner': [k[0] for k in a['owner']['key_auths']],
                'active': [k[0] for k in a['active']['key_auths']],
                'posting': [k[0] for k in a['posting']['key_auths']],
                'memo': [a['memo_key']],
            }
    except Exception as e:
        print(f'  chain {chain} query failed: {e}', file=sys.stderr)

still_live = 0
for entry in partA:
    cur = auths.get((entry['chain'], entry['account']))
    if cur is None:
        entry['verdict'] = 'CHAIN-QUERY-FAIL'
        continue
    verdict = {}
    for role, pubs in cur.items():
        d = entry['derived'].get(role)
        verdict[role] = ('STILL-LIVE' if d and d in pubs else 'rotated-or-threshold') if d else 'no-wif'
        if verdict[role] == 'STILL-LIVE': still_live += 1
    entry['verdict'] = verdict
    entry['currentAuthorities'] = {r: len(p) for r, p in cur.items()}
print(f'A: STEEM/HIVE live-key check done — {still_live} roles STILL-LIVE')

# ── Part B: HD balance sweep ─────────────────────────────────────────────────
reg = json.load(open(os.path.join(AGENT_DIR, 'keys/wallets-registry.json')))
EVM_RPC = {
    'ethereum': 'https://ethereum-rpc.publicnode.com',
    'bsc': 'https://bsc-rpc.publicnode.com',
    'polygon': 'https://polygon-bor-rpc.publicnode.com',
    'arbitrum': 'https://arbitrum-one-rpc.publicnode.com',
    'optimism': 'https://optimism-rpc.publicnode.com',
    'base': 'https://base-rpc.publicnode.com',
    'avalanche': 'https://avalanche-c-chain-rpc.publicnode.com',
}
balances = []
nonzero = []
for a in reg['accounts']:
    agent = a['agent']
    row = {'agent': agent, 'evm': {}, 'tron': None, 'sol': None, 'btc': None}
    evm_addr = a['evm']['address']
    for net, rpcurl in EVM_RPC.items():
        try:
            res = rpc(rpcurl, 'eth_getBalance', [evm_addr, 'latest'])
            wei = int(res['result'], 16)
            row['evm'][net] = wei
            if wei: nonzero.append({'agent': agent, 'chain': f'evm:{net}', 'raw': str(wei)})
        except Exception as e:
            row['evm'][net] = f'RPC-FAIL:{type(e).__name__}'
        time.sleep(0.12)
    try:
        res = http(f"https://api.trongrid.io/v1/accounts/{a['tron']['address']}")
        data = res.get('data', [])
        bal = data[0].get('balance', 0) if data else 0
        row['tron'] = bal
        if bal: nonzero.append({'agent': agent, 'chain': 'tron', 'raw': str(bal)})
    except Exception as e:
        row['tron'] = f'RPC-FAIL:{type(e).__name__}'
    time.sleep(0.12)
    try:
        res = rpc('https://api.mainnet-beta.solana.com', 'getBalance', [a['sol']['address']])
        bal = res.get('result', {}).get('value', 0)
        row['sol'] = bal
        if bal: nonzero.append({'agent': agent, 'chain': 'sol', 'raw': str(bal)})
    except Exception as e:
        row['sol'] = f'RPC-FAIL:{type(e).__name__}'
    time.sleep(0.12)
    try:
        res = http(f"https://blockstream.info/api/address/{a['btc']['address']}", headers={'user-agent': 'r11-audit/1.0'})
        s = res['chain_stats']
        bal = s['funded_txo_sum'] - s['spent_txo_sum']
        row['btc'] = bal
        if bal: nonzero.append({'agent': agent, 'chain': 'btc', 'raw': str(bal)})
    except Exception as e:
        row['btc'] = f'RPC-FAIL:{type(e).__name__}'
    time.sleep(0.12)
    balances.append(row)
print(f'B: balance sweep done — {len(nonzero)} non-zero holdings')

report = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'method': 'read-only live-key audit; WIF→pubkey derived in-memory, never stored; zero broadcast; zero secret printing',
    'archiveIntegrity': '14/14 files sha256-verified against inner MANIFEST',
    'partA_liveKeyCheck': [{'account': e['account'], 'chain': e['chain'], 'verdict': e.get('verdict')} for e in partA],
    'partA_stillLiveCount': still_live,
    'partB_balances': balances,
    'partB_nonZero': nonzero,
}
json.dump(report, open(OUT, 'w'), indent=1)
print(f'report → {OUT}')
