/**
 * Deterministic fixture dataset in raw RESO (MLS Grid) shape.
 *
 * This is SYNTHETIC data. It exists so the entire MCP contract, search logic,
 * pagination, statistics and comparable engines can be exercised and certified
 * before a licensed live MLS Grid token exists. It is not MLS content and must
 * never be presented as real market data.
 *
 * The generator is seeded, so the dataset — and therefore every test assertion
 * built on it — is byte-stable across runs.
 */

export const FIXTURE_ORIGINATING_SYSTEM = 'fixture-northstar';

/** mulberry32: small, fast, fully deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type RawRecord = Record<string, unknown>;

interface CityProfile {
  city: string;
  postal: string;
  county: string;
  basePrice: number;
  count: number;
}

const CITIES: readonly CityProfile[] = [
  { city: 'Woodbury', postal: '55125', county: 'Washington', basePrice: 480_000, count: 96 },
  { city: 'Cottage Grove', postal: '55016', county: 'Washington', basePrice: 385_000, count: 32 },
  { city: 'Lake Elmo', postal: '55042', county: 'Washington', basePrice: 640_000, count: 20 }
];

const SUB_TYPES = ['SingleFamilyResidence', 'Townhouse', 'Condominium'] as const;
const STREETS = ['Radio Dr', 'Bailey Rd', 'Valley Creek Rd', 'Tamarack Rd', 'Pioneer Dr', 'Settlers Ridge Pkwy'] as const;

/**
 * Status mix, chosen to give every engine a workable sample:
 * roughly 40% Closed, 20% Pending, 30% Active, 10% other.
 */
function statusFor(rng: () => number): string {
  const r = rng();
  if (r < 0.4) return 'Closed';
  if (r < 0.6) return 'Pending';
  if (r < 0.9) return 'Active';
  if (r < 0.95) return 'ActiveUnderContract';
  return 'Canceled';
}

/** The dataset's fixed "today". Every generated date is relative to this. */
export const FIXTURE_AS_OF_DATE = '2026-08-30';

function generateListings(): RawRecord[] {
  const rng = mulberry32(20260830);
  const records: RawRecord[] = [];
  let serial = 6_400_000;

  for (const profile of CITIES) {
    for (let i = 0; i < profile.count; i += 1) {
      serial += 1;
      const listingId = `NST${serial}`;
      const subType = pick(rng, SUB_TYPES);
      const beds = 2 + Math.floor(rng() * 4);
      const bathsFull = 1 + Math.floor(rng() * 3);
      const bathsHalf = rng() < 0.45 ? 1 : 0;
      const sqft = roundTo(1_100 + rng() * 2_600, 10);
      const yearBuilt = 1972 + Math.floor(rng() * 52);
      const status = statusFor(rng);

      const priceNoise = 0.72 + rng() * 0.7;
      const sizeFactor = sqft / 2_200;
      const originalListPrice = roundTo(profile.basePrice * priceNoise * sizeFactor, 1_000);
      // Some listings take a reduction; original >= list is the common shape.
      const reduced = rng() < 0.3;
      const listPrice = reduced ? roundTo(originalListPrice * (0.92 + rng() * 0.05), 1_000) : originalListPrice;

      const daysBack = 5 + Math.floor(rng() * 300);
      const listingContractDate = addDays(FIXTURE_AS_OF_DATE, -daysBack);
      const dom = Math.max(1, Math.floor(rng() * 90));

      const record: RawRecord = {
        ListingKey: `FX${serial}`,
        ListingId: listingId,
        OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
        StandardStatus: status,
        MlsStatus: status,
        PropertyType: 'Residential',
        PropertySubType: subType,
        UnparsedAddress: `${1000 + Math.floor(rng() * 8000)} ${pick(rng, STREETS)}, ${profile.city}, MN ${profile.postal}`,
        StreetNumber: String(1000 + Math.floor(rng() * 8000)),
        StreetName: pick(rng, STREETS),
        City: profile.city,
        StateOrProvince: 'MN',
        PostalCode: profile.postal,
        CountyOrParish: profile.county,
        Latitude: 44.9 + rng() * 0.12,
        Longitude: -92.99 + rng() * 0.16,
        ListPrice: listPrice,
        OriginalListPrice: originalListPrice,
        BedroomsTotal: beds,
        BathroomsTotalInteger: bathsFull + bathsHalf,
        BathroomsFull: bathsFull,
        BathroomsHalf: bathsHalf,
        LivingArea: sqft,
        AboveGradeFinishedArea: roundTo(sqft * (0.6 + rng() * 0.3), 10),
        LotSizeAcres: Number((0.15 + rng() * 0.6).toFixed(3)),
        YearBuilt: yearBuilt,
        DaysOnMarket: dom,
        CumulativeDaysOnMarket: dom + Math.floor(rng() * 20),
        ListingContractDate: listingContractDate,
        PublicRemarks: `Synthetic fixture listing in ${profile.city}. Not real MLS content.`,
        PrivateRemarks: 'Synthetic private remark. Only surfaced when explicitly enabled.',
        ListAgentKey: 'FXAGENT-1',
        ListAgentMlsId: '502777',
        ListOfficeKey: 'FXOFFICE-1',
        ListOfficeMlsId: 'RMXR01',
        ModificationTimestamp: `${addDays(listingContractDate, dom)}T14:05:00Z`
      };

      if (status === 'Closed') {
        const closeDate = addDays(listingContractDate, dom + 30);
        // Keep closed sales inside the dataset's window.
        record.CloseDate = closeDate <= FIXTURE_AS_OF_DATE ? closeDate : addDays(FIXTURE_AS_OF_DATE, -7);
        record.PurchaseContractDate = addDays(String(record.CloseDate), -30);
        record.ClosePrice = roundTo(listPrice * (0.94 + rng() * 0.1), 500);
        if (rng() < 0.35) {
          record.ConcessionsAmount = roundTo(2_000 + rng() * 8_000, 500);
          record.ConcessionsComments = 'Seller paid closing costs.';
        }
      } else if (status === 'Pending' || status === 'ActiveUnderContract') {
        record.PurchaseContractDate = addDays(listingContractDate, dom);
      }

      records.push(record);
    }
  }

  return records;
}

/**
 * Hand-written edge cases. These are appended to the generated set so the
 * null-handling, malformed-value, dedupe and unusable-record paths are always
 * exercised, independent of the generator.
 */
function edgeCaseRecords(): RawRecord[] {
  return [
    {
      // Null/missing numerics and dates: must map to null, never a guessed value.
      ListingKey: 'FX-NULLS',
      ListingId: 'NST9000001',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      StandardStatus: 'Active',
      PropertyType: 'Residential',
      PropertySubType: 'SingleFamilyResidence',
      City: 'Woodbury',
      StateOrProvince: 'MN',
      PostalCode: '55125',
      CountyOrParish: 'Washington',
      ListPrice: null,
      BedroomsTotal: null,
      LivingArea: null,
      YearBuilt: null,
      ListingContractDate: null,
      ModificationTimestamp: '2026-08-01T10:00:00Z'
    },
    {
      // Numeric strings (feeds vary) plus an unparseable date.
      ListingKey: 'FX-COERCE',
      ListingId: 'NST9000002',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      StandardStatus: 'Closed',
      PropertyType: 'Residential',
      PropertySubType: 'Townhouse',
      City: 'Woodbury',
      StateOrProvince: 'MN',
      PostalCode: '55125',
      CountyOrParish: 'Washington',
      ListPrice: '425000',
      ClosePrice: '419000',
      OriginalListPrice: '439000',
      BedroomsTotal: '3',
      BathroomsTotalInteger: '2',
      LivingArea: '1980',
      YearBuilt: '2004',
      DaysOnMarket: '22',
      ListingContractDate: '2026-05-02',
      CloseDate: '2026-06-20',
      ModificationTimestamp: 'not-a-timestamp'
    },
    {
      // Duplicate of FX-COERCE by listing key: must be deduplicated.
      ListingKey: 'FX-COERCE',
      ListingId: 'NST9000002',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      StandardStatus: 'Closed',
      PropertyType: 'Residential',
      PropertySubType: 'Townhouse',
      City: 'Woodbury',
      StateOrProvince: 'MN',
      PostalCode: '55125',
      CountyOrParish: 'Washington',
      ListPrice: '425000',
      ClosePrice: '419000',
      LivingArea: '1980',
      ModificationTimestamp: '2026-06-21T09:00:00Z'
    },
    {
      // No stable key: unusable, must be dropped rather than synthesized.
      ListingId: null,
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      StandardStatus: 'Active',
      City: 'Woodbury'
    },
    {
      // Unknown status value: must map to null rather than being coerced.
      ListingKey: 'FX-UNKNOWNSTATUS',
      ListingId: 'NST9000003',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      StandardStatus: 'Reactivated',
      PropertyType: 'Residential',
      City: 'Woodbury',
      PostalCode: '55125',
      CountyOrParish: 'Washington',
      ListPrice: 500_000,
      ModificationTimestamp: '2026-08-10T10:00:00Z'
    },
    {
      // Belongs to a different originating system: must never appear in results.
      ListingKey: 'FX-OTHERSYS',
      ListingId: 'OTH1000001',
      OriginatingSystemName: 'some-other-mls',
      StandardStatus: 'Active',
      PropertyType: 'Residential',
      City: 'Woodbury',
      PostalCode: '55125',
      ListPrice: 999_000,
      ModificationTimestamp: '2026-08-11T10:00:00Z'
    }
  ];
}

let cached: RawRecord[] | null = null;

/** The full raw fixture property dataset (generated + edge cases). */
export function fixtureProperties(): RawRecord[] {
  if (cached === null) cached = [...generateListings(), ...edgeCaseRecords()];
  return cached;
}

export function fixtureMembers(): RawRecord[] {
  return [
    {
      MemberKey: 'FXAGENT-1',
      MemberMlsId: '502777',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      MemberFullName: 'Fixture Listing Agent',
      MemberFirstName: 'Fixture',
      MemberLastName: 'Agent',
      MemberEmail: 'agent@example.invalid',
      MemberPreferredPhone: '651-555-0100',
      OfficeKey: 'FXOFFICE-1',
      OfficeMlsId: 'RMXR01',
      ModificationTimestamp: '2026-07-01T12:00:00Z'
    }
  ];
}

export function fixtureOffices(): RawRecord[] {
  return [
    {
      OfficeKey: 'FXOFFICE-1',
      OfficeMlsId: 'RMXR01',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      OfficeName: 'Fixture Brokerage Office',
      OfficePhone: '651-555-0199',
      City: 'Woodbury',
      StateOrProvince: 'MN',
      PostalCode: '55125',
      ModificationTimestamp: '2026-07-01T12:00:00Z'
    }
  ];
}

export function fixtureOpenHouses(): RawRecord[] {
  return [
    {
      OpenHouseKey: 'FXOH-1',
      ListingKey: 'FX6400001',
      ListingId: 'NST6400001',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      OpenHouseStartTime: '2026-09-06T17:00:00Z',
      OpenHouseEndTime: '2026-09-06T19:00:00Z',
      OpenHouseStatus: 'Active',
      OpenHouseRemarks: 'Synthetic fixture open house.',
      ModificationTimestamp: '2026-08-28T12:00:00Z'
    },
    {
      OpenHouseKey: 'FXOH-2',
      ListingKey: 'FX6400002',
      ListingId: 'NST6400002',
      OriginatingSystemName: FIXTURE_ORIGINATING_SYSTEM,
      OpenHouseStartTime: '2026-09-13T18:00:00Z',
      OpenHouseEndTime: '2026-09-13T20:00:00Z',
      OpenHouseStatus: 'Active',
      ModificationTimestamp: '2026-08-28T12:00:00Z'
    }
  ];
}
