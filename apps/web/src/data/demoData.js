export const DEMO_DATA = {
  kpis: {
    totalClients: 147,
    activeAgreements: 89,
    openQuotes: 23,
    pendingTasks: 34,
    revenueThisMonth: 87450,
    quotesThisMonth: 18,
    expiringAgreements: 7,
    urgentTasks: 3,
  },
  recentQuotes: [
    { id: "1", quoteNumber: "QTE-202602-0018", title: "AC Replacement - 3.5 Ton", total: 7500, status: "SENT", client: { firstName: "Robert", lastName: "Johnson" }, createdAt: "2026-02-14T10:30:00Z" },
    { id: "2", quoteNumber: "QTE-202602-0017", title: "Furnace Repair - Blower Motor", total: 650, status: "APPROVED", client: { firstName: "Patricia", lastName: "Williams" }, createdAt: "2026-02-13T14:15:00Z" },
    { id: "3", quoteNumber: "QTE-202602-0016", title: "Complete System Install", total: 12800, status: "DRAFT", client: { firstName: "Dr. Amanda", lastName: "Chen" }, createdAt: "2026-02-12T09:00:00Z" },
  ],
  upcomingVisits: [
    { id: "1", visitType: "spring_tuneup", scheduledFor: "2026-02-18T09:00:00Z", agreement: { client: { firstName: "Robert", lastName: "Johnson" }, location: { address1: "742 Evergreen Terrace", city: "Atlanta" } } },
    { id: "2", visitType: "fall_tuneup", scheduledFor: "2026-02-19T10:00:00Z", agreement: { client: { firstName: "Dr. Amanda", lastName: "Chen" }, location: { address1: "500 Peachtree St NE", city: "Atlanta" } } },
  ],
  clients: [
    { id: "1", firstName: "Robert", lastName: "Johnson", phone: "(555) 111-2222", email: "rjohnson@email.com", type: "RESIDENTIAL", tags: ["VIP", "maintenance-plan"], _count: { quotes: 5, agreements: 1 }, locations: [{ address1: "742 Evergreen Terrace", city: "Atlanta", state: "GA" }] },
    { id: "2", firstName: "Dr. Amanda", lastName: "Chen", companyName: "Peachtree Dental Group", phone: "(555) 333-4444", email: "achen@peachtreedental.com", type: "COMMERCIAL", tags: ["commercial"], _count: { quotes: 8, agreements: 2 }, locations: [{ address1: "500 Peachtree St NE", city: "Atlanta", state: "GA" }] },
  ],
  equipment: [
    { id: "1", category: "AIR_CONDITIONER", manufacturer: "Carrier", model: "24ACC636A003", serialNumber: "CAR2019AC001", condition: "GOOD", tonnage: 3, seerRating: 16, locationRef: { address1: "742 Evergreen Terrace", city: "Atlanta", client: { firstName: "Robert", lastName: "Johnson" } } },
  ],
  agreements: [
    { id: "1", agreementNumber: "MA-202601-0001", planTier: "GOLD", status: "ACTIVE", amount: 349, billingFrequency: "ANNUAL", endDate: "2027-01-15", visitsIncluded: 2, visitsUsed: 0, client: { firstName: "Robert", lastName: "Johnson" }, location: { address1: "742 Evergreen Terrace", city: "Atlanta" } },
  ],
  agents: [
    { id: "1", name: "Agreement Renewal Reminder", description: "Checks for agreements expiring in 30 days", triggerType: "SCHEDULE", isEnabled: true, lastRunAt: "2026-02-10T08:00:00Z", _count: { runs: 6 } },
  ],
  agreementPlans: [
    { tier: "BRONZE", price: "$149/yr", visits: "1 visit", discount: "5% parts" },
    { tier: "SILVER", price: "$249/yr", visits: "2 visits", discount: "10% labor & parts" },
    { tier: "GOLD", price: "$349/yr", visits: "2 visits", discount: "15% + priority" },
    { tier: "PLATINUM", price: "$499/yr", visits: "4 visits", discount: "20% + priority" },
  ],
};
