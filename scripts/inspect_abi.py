import json

with open('docs/nearlytrade_abi.json', 'r', encoding='utf-8') as f:
    abi = json.load(f)

print(f"Total functions: {len(abi['body']['functions'])}")
print("=" * 80)

for fn in abi['body']['functions']:
    name = fn['name']
    modifiers = fn.get('modifiers', [])
    doc = fn.get('doc', '')
    args = fn.get('params', {}).get('args', [])
    arg_strs = []
    for a in args:
        ts = a.get('type_schema', {})
        t = ts.get('$ref', ts.get('type', 'any'))
        arg_strs.append(f"{a['name']}: {t}")
    ret_s = fn.get('result', {}).get('type_schema', {})
    ret = ret_s.get('$ref', ret_s.get('type', 'void'))
    mods = ", ".join(modifiers) if modifiers else "view"
    print(f"[{mods:12}] {name}({', '.join(arg_strs)}) -> {ret}")

print("\n" + "=" * 80)
print("Key types:")
root_types = abi['body'].get('root_schema', {}).get('definitions', {})
for tname, tdef in root_types.items():
    if any(k in tname.lower() for k in ['launch', 'quote', 'pool', 'phase', 'state']):
        print(f"\nType: {tname}")
        print(json.dumps(tdef, indent=2))
