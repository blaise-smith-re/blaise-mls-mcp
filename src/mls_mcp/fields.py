"""RESO Data Dictionary field sets, enumerations and resource names.

Field names follow the RESO Data Dictionary so the server works against any
RESO-certified feed. Feeds expose different subsets and add local fields, so
these lists are defaults, not guarantees — ``mls_describe_metadata`` reports
what a particular feed actually offers, and ``$select`` failures fall back to
requesting every field.
"""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

# --- Resources -------------------------------------------------------------

PROPERTY = "Property"
MEMBER = "Member"
OFFICE = "Office"
MEDIA = "Media"
OPEN_HOUSE = "OpenHouse"

# --- Property fields -------------------------------------------------------

PROPERTY_SUMMARY_FIELDS: List[str] = [
    "ListingKey",
    "ListingId",
    "StandardStatus",
    "PropertyType",
    "PropertySubType",
    "ListPrice",
    "ClosePrice",
    "CloseDate",
    "BedroomsTotal",
    "BathroomsTotalInteger",
    "LivingArea",
    "LotSizeAcres",
    "YearBuilt",
    "DaysOnMarket",
    "UnparsedAddress",
    "StreetNumber",
    "StreetName",
    "City",
    "StateOrProvince",
    "PostalCode",
    "SubdivisionName",
    "Latitude",
    "Longitude",
    "ModificationTimestamp",
]

PROPERTY_DETAIL_FIELDS: List[str] = PROPERTY_SUMMARY_FIELDS + [
    "OriginalListPrice",
    "PreviousListPrice",
    "MlsStatus",
    "CountyOrParish",
    "PublicRemarks",
    "PrivateRemarks",
    "ListingContractDate",
    "OnMarketDate",
    "PurchaseContractDate",
    "OffMarketDate",
    "CumulativeDaysOnMarket",
    "BathroomsFull",
    "BathroomsHalf",
    "RoomsTotal",
    "StoriesTotal",
    "LotSizeSquareFeet",
    "AboveGradeFinishedArea",
    "BelowGradeFinishedArea",
    "GarageSpaces",
    "ParkingTotal",
    "PoolPrivateYN",
    "WaterfrontYN",
    "NewConstructionYN",
    "AssociationFee",
    "AssociationFeeFrequency",
    "TaxAnnualAmount",
    "TaxYear",
    "ParcelNumber",
    "Heating",
    "Cooling",
    "Appliances",
    "InteriorFeatures",
    "ExteriorFeatures",
    "ConstructionMaterials",
    "Roof",
    "Sewer",
    "WaterSource",
    "ElementarySchool",
    "MiddleOrJuniorSchool",
    "HighSchool",
    "ListAgentFullName",
    "ListAgentMlsId",
    "ListAgentPreferredPhone",
    "ListAgentEmail",
    "ListOfficeName",
    "ListOfficeMlsId",
    "BuyerAgentFullName",
    "BuyerOfficeName",
    "PhotosCount",
    "VirtualTourURLUnbranded",
]

# Fields used for comparable-sales analysis; kept small because these queries
# pull many records.
PROPERTY_COMP_FIELDS: List[str] = [
    "ListingKey",
    "ListingId",
    "StandardStatus",
    "PropertyType",
    "PropertySubType",
    "ListPrice",
    "ClosePrice",
    "CloseDate",
    "BedroomsTotal",
    "BathroomsTotalInteger",
    "LivingArea",
    "LotSizeAcres",
    "YearBuilt",
    "DaysOnMarket",
    "UnparsedAddress",
    "City",
    "PostalCode",
    "SubdivisionName",
    "Latitude",
    "Longitude",
]

# Fields used for market statistics; the smallest set that supports the maths.
PROPERTY_STATS_FIELDS: List[str] = [
    "ListingKey",
    "StandardStatus",
    "ListPrice",
    "ClosePrice",
    "CloseDate",
    "LivingArea",
    "DaysOnMarket",
    "BedroomsTotal",
    "PropertyType",
]

MEDIA_FIELDS: List[str] = [
    "MediaKey",
    "ResourceRecordKey",
    "ResourceName",
    "MediaURL",
    "MediaCategory",
    "MediaType",
    "Order",
    "ShortDescription",
    "LongDescription",
    "PreferredPhotoYN",
    "ModificationTimestamp",
]

MEMBER_FIELDS: List[str] = [
    "MemberKey",
    "MemberMlsId",
    "MemberFullName",
    "MemberFirstName",
    "MemberLastName",
    "MemberEmail",
    "MemberPreferredPhone",
    "MemberMobilePhone",
    "MemberStatus",
    "MemberType",
    "OfficeKey",
    "OfficeMlsId",
    "OfficeName",
    "MemberStateLicense",
    "ModificationTimestamp",
]

OFFICE_FIELDS: List[str] = [
    "OfficeKey",
    "OfficeMlsId",
    "OfficeName",
    "OfficePhone",
    "OfficeEmail",
    "OfficeAddress1",
    "OfficeCity",
    "OfficeStateOrProvince",
    "OfficePostalCode",
    "OfficeStatus",
    "MainOfficeKey",
    "ModificationTimestamp",
]

OPEN_HOUSE_FIELDS: List[str] = [
    "OpenHouseKey",
    "ListingKey",
    "ListingId",
    "OpenHouseDate",
    "OpenHouseStartTime",
    "OpenHouseEndTime",
    "OpenHouseStatus",
    "OpenHouseType",
    "OpenHouseRemarks",
    "ShowingAgentFirstName",
    "ShowingAgentLastName",
    "ModificationTimestamp",
]

RESOURCE_DEFAULT_FIELDS: Dict[str, List[str]] = {
    PROPERTY: PROPERTY_SUMMARY_FIELDS,
    MEDIA: MEDIA_FIELDS,
    MEMBER: MEMBER_FIELDS,
    OFFICE: OFFICE_FIELDS,
    OPEN_HOUSE: OPEN_HOUSE_FIELDS,
}

# --- Enumerations ----------------------------------------------------------

# RESO Data Dictionary StandardStatus. Every certified feed uses these exact
# strings, which is what makes cross-MLS filtering possible.
STANDARD_STATUSES: Tuple[str, ...] = (
    "Active",
    "Active Under Contract",
    "Canceled",
    "Closed",
    "Coming Soon",
    "Delete",
    "Expired",
    "Hold",
    "Incomplete",
    "Pending",
    "Withdrawn",
)

# Convenience groupings for the common "what can I show a buyer" questions.
STATUS_GROUPS: Dict[str, Tuple[str, ...]] = {
    "for_sale": ("Active", "Coming Soon"),
    "under_contract": ("Active Under Contract", "Pending"),
    "sold": ("Closed",),
    "off_market": ("Canceled", "Expired", "Withdrawn"),
    "active_and_pending": ("Active", "Coming Soon", "Active Under Contract", "Pending"),
}

# PropertyType is "open with enumerations" in the Data Dictionary: feeds may add
# local values, so these are documented defaults rather than a closed set.
COMMON_PROPERTY_TYPES: Tuple[str, ...] = (
    "Residential",
    "Residential Lease",
    "Residential Income",
    "Land",
    "Commercial Sale",
    "Commercial Lease",
    "Business Opportunity",
    "Farm",
    "Manufactured In Park",
)

# Free-text search targets, in priority order. Feeds that omit one of these
# still work because unknown fields are dropped before the query is built.
KEYWORD_SEARCH_FIELDS: Tuple[str, ...] = (
    "PublicRemarks",
    "UnparsedAddress",
    "SubdivisionName",
)


def resolve_statuses(
    status: Sequence[str] | None, status_group: str | None
) -> List[str]:
    """Resolve explicit statuses and/or a named group into a status list."""
    resolved: List[str] = []
    if status_group:
        key = status_group.strip().lower()
        if key not in STATUS_GROUPS:
            valid = ", ".join(sorted(STATUS_GROUPS))
            raise ValueError(f"Unknown status_group {status_group!r}. Valid groups: {valid}")
        resolved.extend(STATUS_GROUPS[key])
    if status:
        resolved.extend(status)
    # Preserve order while removing duplicates.
    seen = set()
    unique = []
    for value in resolved:
        if value not in seen:
            seen.add(value)
            unique.append(value)
    return unique
