# S6-06 Resales Online connector vs the proven SPW adapter (2026-10-20)

The S6-06 connector was built without official docs; its fixtures were shaped to the code. The SPW project has a Resales Online import that is in production. This compares the two. **Conclusion: as built, S6-06 would most likely import nothing.** It drops every record whose `AgencyId` does not match, and that field appears nowhere in SPW's code, docs or live probes. Fix this in follow-up **S6-F4** before Resales goes live. The user marked Resales as the important import.

**Reference, read-only:**
- `E:\Repos\SPW-AI\spw\apps\api\src\modules\feed\adapters\resales.adapter.ts` is the proven code. Where its comments disagree with the doc (page size, meaning of Location), the comments are newer and win.
- `E:\Repos\SPW-AI\spw\docs\resales-feed.md`
- The live probe scripts in `E:\Repos\SPW-AI\spw\scripts\deploy\`.

**Live testing:** the API key works only from IP-whitelisted servers, so a local live run is impossible (the user, 2026-10-20). Check against the live API from a whitelisted server, or record real responses there and use them as fixtures.

| Inmolink assumption | SPW actual (proven) | Change needed |
|---|---|---|
| `p_agency_filterid=1` means "own properties" | It is the **Filter Alias** configured in the agency's Resales portal: `1` = Sale, `2` = Short Term Rent, `3` = Long Term Rent, `4` = Featured. Sending the numeric Filter Id returns `FilterAgencyId not valid` | Make the alias a connection setting, with one feed per alias. Take the transaction type from `QueryInfo.SearchType` or from the alias; do not hard-code SALE |
| Own listings only via `AgencyId === settings.agencyId` (falls back to p1) | SPW never filters by owner. It reads `OwnProperty` (also tries `Own` and `IsOwnProperty`): `"1"` = own, `"0"` = shared, stored only as a flag. Even that field name is a guess | Remove the `AgencyId` gate. Confirm the real own-property field with a live response, then filter on it (PLAN §3 #17: own listings only) |
| `p_PageNo`, `p_PageSize` | `P_PageNo`, `P_PageSize` | Use SPW's capitalisation |
| Page size | The API caps it at 40, whatever is asked. Read the real size from `QueryInfo.PropertiesPerPage`; SPW once stopped at 520 of 1,227 because of this | The counting logic is fine; the fixture should use the real field |
| `transaction.status` must equal `'success'` | Fail only on `=== 'error'`. Messages are in `transaction.errordescription{}`, plus `incomingIp`. The body may be wrapped in `root` | Read `data.root \|\| data`, fail only on `'error'`, and surface the error descriptions |
| Integer `Price` only | Strings with commas (`"550,000"`). Ranges on developments (`"96091 - 234530"`). Rentals use `RentalPrice1`, `RentalPrice2` and `RentalPeriod`. `POA` means price on request | Strip separators; handle ranges, rentals and POA |
| `PropertyType.Type`, falling back to `NameType` | `NameType` (subtype) first. On developments `NameType` = "New Development", so use `Subtype1` | Swap the order and handle developments |
| Integer bedrooms and bathrooms | `"2.5"` with `P_DecimalBaths=1`; ranges such as `"1 - 3"` | Parse ranges and decimals |
| Plot = `GardenPlot` | `GardenPlot ?? Plot`; built = `Built ?? BuiltArea` | Add the fallbacks |
| Coordinates from the search list | Only from **`PropertyDetails`** with `P_ShowGPSCoords=TRUE`, as `Latitude`/`Longitude`, `GPS_Latitude`/`GPS_Longitude` or `GpsX`/`GpsY` | Add a details call; SPW runs 5 at a time |
| Gate on `Status.system === 'Available'` | SPW reads `Status.en` or a plain string and does not filter on status | Check the real shape before gating on it |
| Location: `Province` → region, `Location` → city, `SubLocation` → area | List: `Area` = coastal region, `Location` = town or district, `SubLocation` = urbanisation. Details nest them under `Location.{LocationName,Province,Area,SubLocation}` | Re-map the levels |
| Pictures and features | `Pictures.Picture[].PictureURL` (+ `PictureCaption`); `PropertyFeatures.Category[].{Type,Value[]}` | Already match |
| Total in `QueryInfo.PropertyCount` | Same | None |
| One request, text tagged with the default locale | `P_Lang` is **numeric**: es 2, de 3, fr 4, nl 5, da 6, ru 7, sv 8, pl 9, no 10, tr 11, fi 13, hu 14, vi 15 (English is the default). Letter codes are silently ignored. One `SearchProperties` call per language per page; drop text identical to the English, which is Resales' fallback | Fetch English first and label it `en`, then add the per-language calls |

**Other lessons from SPW:**
- **Credentials:** `p1` is the numeric Client ID, `p2` the 40-hex API key; Inmolink has these right. SPW never sends `P_ApiId`, `P_sandbox` or `P_All`.
- **Retries:** when Resales is busy it answers with the same "P1 or P2 not valid" text as for wrong keys. SPW retries 3 times with a 2 s / 4 s backoff before treating it as a credentials error. Inmolink classifies config/API errors as final, which needs to change for this case.
- **Details-only fields:** `CommunityFees`, `IBI`, `Basura`, `BuiltYear`, coordinates and the development `PriceList` (units) come only from `/PropertyDetails`. The `*_Year` fees are yearly.
- **New developments:** detected when `NameType` contains "development", `KeyReady` is non-empty, or a Category value is "New Development".
- **Errors:** Inmolink turns non-2xx responses into `FeedHttpStatusError` and loses Resales' error body.
- **Security (SPW repo, not this one):** `scripts/deploy/check-resales-fields.sh` in SPW holds a live Client ID and API key in plain text. Rotate them and remove the file from that repo.
