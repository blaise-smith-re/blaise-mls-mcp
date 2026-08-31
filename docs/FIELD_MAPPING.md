# Normalized field mapping

RESO Web API (MLS Grid) source fields → normalized internal model. Implemented in
`src/provider/mlsgrid/mapping.ts`; the fixture adapter uses the same module, so both lanes normalize
identically.

## Mapping rules

1. **Missing means null.** An absent, null, empty-string, or wrong-typed source value maps to `null`.
   Never `0`, never `""`, never a default, never carried forward from another field.
2. **Numeric strings are parsed, not guessed.** `"425000"` → `425000` (feeds vary in typing).
   `"about 425k"` → `null`.
3. **Unrecognized enum values map to null.** `StandardStatus: "Reactivated"` → `null`, and the record
   is excluded from every statistical cohort rather than assigned to one.
4. **Calendar dates are not zone-shifted.** A RESO date field is a calendar date; converting through a
   timezone could move a close date across a day boundary, so only the `YYYY-MM-DD` portion is taken.
   Timestamps *are* normalized to ISO 8601 UTC.
5. **Records without a stable key are dropped.** No synthetic key is ever invented.

## Listing (Property → `NormalizedListing`)

| Normalized field | RESO source | Notes |
|---|---|---|
| `listing_key` | `ListingKey`, falling back to `ListingId` | Dedupe key. Record dropped if both absent |
| `listing_id` | `ListingId` | MLS number |
| `originating_system` | `OriginatingSystemName` | Falls back to configured system |
| `standard_status` | `StandardStatus` | Normalized to the known enum; unknown → `null` |
| `mls_status` | `MlsStatus` | Raw local status, unnormalized |
| `property_type` / `property_sub_type` | `PropertyType` / `PropertySubType` | |
| `address.unparsed` | `UnparsedAddress` | Exact-match target for address lookup |
| `address.street_number` | `StreetNumber` | |
| `address.street_name` | `StreetDirPrefix` + `StreetName` + `StreetSuffix` + `StreetDirSuffix` | Joined, present parts only |
| `address.unit` | `UnitNumber` | |
| `address.city` / `state` / `postal_code` / `county` | `City` / `StateOrProvince` / `PostalCode` / `CountyOrParish` | |
| `latitude` / `longitude` | `Latitude` / `Longitude` | |
| `list_price` | `ListPrice` | |
| `original_list_price` | `OriginalListPrice` | Differs from `list_price` ⇒ at least one price change occurred |
| `close_price` | `ClosePrice` | |
| `bedrooms_total` | `BedroomsTotal` | |
| `bathrooms_total` | `BathroomsTotalInteger`, falling back to `BathroomsTotal` | |
| `bathrooms_full` / `bathrooms_half` | `BathroomsFull` / `BathroomsHalf` | |
| `living_area_sqft` | `LivingArea` | Denominator for price-per-sqft |
| `above_grade_finished_area_sqft` | `AboveGradeFinishedArea` | |
| `below_grade_finished_area_sqft` | `BelowGradeFinishedArea` | |
| `lot_size_acres` / `lot_size_sqft` | `LotSizeAcres` / `LotSizeSquareFeet` | Not derived from one another |
| `year_built` | `YearBuilt` | |
| `days_on_market` | `DaysOnMarket` | Source-reported; never recomputed |
| `cumulative_days_on_market` | `CumulativeDaysOnMarket` | |
| `listing_contract_date` | `ListingContractDate` | |
| `purchase_contract_date` | `PurchaseContractDate` | |
| `close_date` | `CloseDate` | |
| `concessions_amount` | `ConcessionsAmount` | Absent ≠ zero; excluded from concession statistics |
| `concessions_comments` | `ConcessionsComments` | |
| `public_remarks` | `PublicRemarks` | |
| `private_remarks` | `PrivateRemarks` | **Only** when the licensed feed exposes it *and* `MLSGRID_EXPOSE_PRIVATE_REMARKS=true`. Otherwise `null` |
| `list_agent_key` / `list_agent_mls_id` | `ListAgentKey` / `ListAgentMlsId` | |
| `list_office_key` / `list_office_mls_id` | `ListOfficeKey` / `ListOfficeMlsId` | |
| `media` | `Media[]` → `{url, order, description}` | Requires `$expand=Media`. Entries without `MediaURL` are skipped. `null` when the collection is absent |
| `modification_timestamp` | `ModificationTimestamp` | ISO 8601 UTC |
| `source` | Derived | Provenance: provider, originating system, resource, fetch time, record modification timestamp |

## Member, Office, OpenHouse

| Normalized | RESO source |
|---|---|
| `NormalizedMember.member_key` | `MemberKey` → `MemberMlsId` |
| `.member_mls_id` / `.full_name` / `.first_name` / `.last_name` | `MemberMlsId` / `MemberFullName` / `MemberFirstName` / `MemberLastName` |
| `.email` / `.phone` | `MemberEmail` / `MemberPreferredPhone` → `MemberDirectPhone` |
| `.office_key` / `.office_mls_id` | `OfficeKey` / `OfficeMlsId` |
| `NormalizedOffice.office_key` | `OfficeKey` → `OfficeMlsId` |
| `.name` / `.phone` | `OfficeName` / `OfficePhone` |
| `NormalizedOpenHouse.open_house_key` | `OpenHouseKey` (required; record dropped without it) |
| `.listing_key` / `.listing_id` | `ListingKey` / `ListingId` |
| `.start_time` / `.end_time` | `OpenHouseStartTime` / `OpenHouseEndTime` (ISO 8601 UTC) |
| `.remarks` / `.status` | `OpenHouseRemarks` / `OpenHouseStatus` |

## Fields deliberately not mapped

**Event-level listing history.** No price-change or status-change timeline is reconstructed from
current-state records. `get_listing_history` returns the capability limitation plus the
history-adjacent fields above.

**Anything requiring inference.** No estimated value, no computed DOM, no derived square footage, no
"assumed zero" concessions.

## Verification status

Every RESO field name above is documentation-derived and **unconfirmed against live `$metadata`**.
Certification step 9 (field semantics) reconciles these names and their meanings against Matrix — in
particular `LivingArea` vs above/below grade area, `DaysOnMarket` vs `CumulativeDaysOnMarket`, and
whether the licensed feed exposes concessions and private remarks at all.
