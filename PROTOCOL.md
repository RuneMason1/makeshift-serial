# MakeShift Runtime Protocol

The first byte of every SLIP packet is a `PacketType`. Packet IDs are append-only
and must remain aligned with the firmware `MessageType` enum.

## Runtime manifest

Ctrl sends a complete manifest when a device connects and whenever live cue
requirements change. Firmware applies it transactionally; an invalid or
incomplete transaction leaves the previous active manifest intact.

- `RUNTIME_MANIFEST_BEGIN` (`17`): `version:u8`, `componentCount:u8`
- `RUNTIME_COMPONENT` (`18`): `id:u8`, `type:u8`, `zone:u8`, `flags:u8`
- `RUNTIME_MANIFEST_COMMIT` (`19`): no body
- `RUNTIME_CAPABILITIES` (`20`): request has no body; response contains
  `version:u8`, `maxComponents:u8`, `componentTypeMask:u8`, `zoneMask:u8`

Protocol version 1 supports at most eight active components. Firmware boots with
a compatibility carousel component until ctrl commits its first valid manifest.

## Cached assets

Asset names remain host-side semantics. Firmware receives numeric IDs and format
metadata only. Transfers are transactional and a cached slot is replaced only
after a complete valid commit.

- `ASSET_BEGIN` (`21`): `id:u8`, `format:u8`, `width:u8`, `height:u8`,
  `length:u16be`
- `ASSET_CHUNK` (`22`): `offset:u16be`, `data:bytes`
- `ASSET_COMMIT` (`23`): no body

Format `1` is row-major, most-significant-bit-first, 1-bit monochrome. Version 1
firmware provides eight 128-byte slots and accepts dimensions up to 32 by 32.

Ctrl aggregates `requiredAssets` from cue modules currently bound in live layout
layers, deduplicates the semantic names, resolves them through its asset catalog,
and preloads them at connection time. Example cue metadata:

```js
const requiredAssets = [
  'media.previous',
  'media.play-pause',
  'media.next',
]
```

Unknown host asset names are ignored. Missing cached assets use firmware-native
fallback rendering, so old ctrl versions and interrupted transfers remain usable.

Component activation follows the same live-cue model through
`requiredComponents`. For example, the Steam cue declares
`requiredComponents = ['carousel']`; installing its plugin alone does not enable
the firmware component.
