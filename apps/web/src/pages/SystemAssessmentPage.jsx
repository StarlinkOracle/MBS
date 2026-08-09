import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { formatDateTime, getErrorText } from "../utils/format";

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const asArray = (value) => (Array.isArray(value) ? value : []);

const DECISION_CHOICES = {
  MATCH_EXISTING: "MATCH_EXISTING",
  USE_RECOMMENDED: "USE_RECOMMENDED",
  MANUAL_OVERRIDE: "MANUAL_OVERRIDE",
};

const INSTALL_TYPES = [
  { value: "COMBO", label: "Combo (Furnace + A/C)" },
  { value: "FURNACE_ONLY", label: "Furnace Only" },
  { value: "AC_ONLY", label: "A/C Only" },
];

const ACCESS_TYPES = [
  { value: "STANDARD", label: "Standard" },
  { value: "ATTIC", label: "Attic" },
  { value: "CONFINED_CRAWLSPACE", label: "Confined Crawlspace" },
];

const TIER_KEYS = ["GOOD", "BETTER", "BEST"];

const DEFAULT_TIER_SELECTIONS = {
  GOOD: {
    equipmentLabel: "Good equipment",
    equipmentCost: "",
    materialsLabel: "Good materials",
    materialsCost: "",
  },
  BETTER: {
    equipmentLabel: "Better equipment",
    equipmentCost: "",
    materialsLabel: "Better materials",
    materialsCost: "",
  },
  BEST: {
    equipmentLabel: "Best equipment",
    equipmentCost: "",
    materialsLabel: "Best materials",
    materialsCost: "",
  },
};

const defaultPricingInputs = {
  installType: "COMBO",
  accessType: "STANDARD",
  baseLaborCost: "0",
  manualLaborAdjustment: "0",
  manualLaborReason: "",
  permitCost: "0",
};

const parseNumberInput = (value) => {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
};

const parseDollarsToCents = (value) => {
  if (value === "" || value === null || value === undefined) {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric * 100);
};

const toDollarsInput = (cents) => {
  if (typeof cents !== "number" || !Number.isFinite(cents)) {
    return "0";
  }
  return (cents / 100).toFixed(2);
};

const formatCurrency = (cents) => {
  if (typeof cents !== "number" || !Number.isFinite(cents)) {
    return "—";
  }
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const guardrailLabel = (status) => {
  if (status === "WARNING") {
    return "Review recommended";
  }
  if (status === "REQUIRE_APPROVAL") {
    return "Manager approval required";
  }
  if (status === "BLOCK") {
    return "Blocked—owner required";
  }
  return "Ready";
};

const guardrailTone = (status, theme) => {
  if (status === "WARNING") {
    return {
      color: theme.colors.amber,
      background: `${theme.colors.amber}22`,
      border: `1px solid ${theme.colors.amber}55`,
    };
  }
  if (status === "REQUIRE_APPROVAL") {
    return {
      color: "#FFD48A",
      background: "rgba(255, 176, 32, 0.18)",
      border: "1px solid rgba(255, 176, 32, 0.45)",
    };
  }
  if (status === "BLOCK") {
    return {
      color: "#FFB8BE",
      background: "rgba(255, 71, 87, 0.18)",
      border: "1px solid rgba(255, 71, 87, 0.48)",
    };
  }
  return {
    color: theme.colors.teal,
    background: `${theme.colors.teal}18`,
    border: `1px solid ${theme.colors.teal}55`,
  };
};

const optionSortWeight = {
  GOOD: 1,
  BETTER: 2,
  BEST: 3,
};

const sortOptions = (options) =>
  [...asArray(options)].sort((a, b) => {
    const aKey = String(a?.optionKey || "").toUpperCase();
    const bKey = String(b?.optionKey || "").toUpperCase();
    return (optionSortWeight[aKey] || 999) - (optionSortWeight[bKey] || 999);
  });

export const SystemAssessmentPage = ({
  theme,
  navigate,
  assessmentId,
  roles = [],
  hasPermission,
}) => {
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingDecision, setSavingDecision] = useState(false);
  const [openingAttachmentId, setOpeningAttachmentId] = useState("");

  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const [recommendedTonnage, setRecommendedTonnage] = useState("");
  const [recommendedBtu, setRecommendedBtu] = useState("");
  const [confirmedBySupplyHouse, setConfirmedBySupplyHouse] = useState(false);
  const [supplyHouseNotes, setSupplyHouseNotes] = useState("");

  const [showMismatchModal, setShowMismatchModal] = useState(false);
  const [decisionChoice, setDecisionChoice] = useState(
    DECISION_CHOICES.MATCH_EXISTING,
  );
  const [decisionReason, setDecisionReason] = useState("");
  const [manualTonnage, setManualTonnage] = useState("");
  const [manualBtu, setManualBtu] = useState("");

  const [pricingInputs, setPricingInputs] = useState(defaultPricingInputs);
  const [pricingSectionBusy, setPricingSectionBusy] = useState(false);
  const [pricingInitializedForAssessmentId, setPricingInitializedForAssessmentId] =
    useState("");

  const [leadId, setLeadId] = useState("");
  const [tierSelections, setTierSelections] = useState(DEFAULT_TIER_SELECTIONS);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [activeQuoteId, setActiveQuoteId] = useState("");
  const [activeQuote, setActiveQuote] = useState(null);

  const [discountDrafts, setDiscountDrafts] = useState({});
  const [discountBusyOptionId, setDiscountBusyOptionId] = useState("");
  const [overrideBusyOptionId, setOverrideBusyOptionId] = useState("");

  const fetchAssessment = useCallback(
    ({ signal }) => apiClient.get(`/system-assessments/${assessmentId}`, { signal }),
    [assessmentId],
  );

  const assessmentQuery = useQuery(["system-assessment", assessmentId], fetchAssessment, {
    enabled: Boolean(assessmentId),
    cacheTime: 2500,
  });

  const assessment = assessmentQuery.data?.assessment || null;

  const normalizedRoles = useMemo(
    () => asArray(roles).map((role) => String(role).toLowerCase()),
    [roles],
  );

  const isTech = normalizedRoles.some((role) => role.includes("tech"));
  const canApplyDiscount =
    typeof hasPermission === "function" &&
    (hasPermission("pricing:discount:apply_pct") ||
      hasPermission("pricing:discount:apply_cents") ||
      hasPermission("*"));
  const canOverrideBlock =
    typeof hasPermission === "function" &&
    (hasPermission("pricing:block:override") || hasPermission("*"));
  const canSeeCostDetails =
    typeof hasPermission === "function" &&
    (hasPermission("pricebook:cost:read") || hasPermission("*"));

  const attachments = useMemo(
    () => asArray(assessment?.assessmentAttachments),
    [assessment],
  );
  const latestLookupRun = useMemo(
    () => asArray(assessment?.equipmentLookupRuns)[0] || null,
    [assessment],
  );
  const latestSpec = latestLookupRun?.selectedSpec || null;

  const existingTonnage =
    typeof assessment?.existingTonnage === "number" ? assessment.existingTonnage : null;
  const existingBtu =
    typeof assessment?.existingFurnaceBtu === "number"
      ? assessment.existingFurnaceBtu
      : null;

  const latestConfidence =
    typeof latestSpec?.confidence === "number" ? latestSpec.confidence : null;
  const isLowConfidence = latestConfidence !== null && latestConfidence < 0.7;
  const hasNameplatePhoto = attachments.length > 0;

  const recommendedTonnageValue = parseNumberInput(recommendedTonnage);
  const recommendedBtuValue = parseNumberInput(recommendedBtu);

  const hasMismatch =
    (existingTonnage !== null &&
      recommendedTonnageValue !== null &&
      Math.abs(existingTonnage - recommendedTonnageValue) > 0.01) ||
    (existingBtu !== null &&
      recommendedBtuValue !== null &&
      Math.abs(existingBtu - recommendedBtuValue) > 0.5);

  useEffect(() => {
    if (!assessment?.id) {
      return;
    }

    if (pricingInitializedForAssessmentId === assessment.id) {
      return;
    }

    setPricingInputs({
      installType: assessment.installType || "COMBO",
      accessType: assessment.accessType || "STANDARD",
      baseLaborCost: toDollarsInput(assessment.baseLaborCostCents),
      manualLaborAdjustment: toDollarsInput(assessment.manualLaborAdjustmentCents),
      manualLaborReason: assessment.manualLaborReason || "",
      permitCost: toDollarsInput(assessment.permitCostCents),
    });

    setLeadId(assessment?.quotes?.[0]?.leadId || "");
    setPricingInitializedForAssessmentId(assessment.id);
  }, [assessment, pricingInitializedForAssessmentId]);

  useEffect(() => {
    if (!assessment?.quotes?.length) {
      setActiveQuoteId("");
      setActiveQuote(null);
      return;
    }

    const sortedQuotes = [...assessment.quotes].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const selectedQuote =
      sortedQuotes.find((quote) => quote.id === activeQuoteId) || sortedQuotes[0];

    setActiveQuoteId(selectedQuote.id);
    setActiveQuote({
      ...selectedQuote,
      options: sortOptions(selectedQuote.options),
    });
  }, [assessment, activeQuoteId]);

  const createAssessment = useCallback(async () => {
    setCreating(true);
    setActionError("");
    setActionMessage("");

    try {
      const result = await apiClient.post("/system-assessments", {});
      if (result?.status !== "EXECUTED") {
        throw new Error(
          result?.reason || result?.error || result?.status || "Assessment creation blocked",
        );
      }

      const output = asObject(result.output);
      const nextAssessmentId =
        typeof output.assessmentId === "string"
          ? output.assessmentId
          : typeof asObject(output.assessment).id === "string"
            ? asObject(output.assessment).id
            : "";

      if (!nextAssessmentId) {
        throw new Error("Assessment create response did not include an assessmentId");
      }

      setActionMessage("Assessment created.");
      navigate(`/assessments/${nextAssessmentId}`);
    } catch (error) {
      setActionError(getErrorText(error, "Unable to create system assessment"));
    } finally {
      setCreating(false);
    }
  }, [navigate]);

  const uploadNameplate = useCallback(
    async (file) => {
      if (!assessmentId || !file) {
        return;
      }

      setUploading(true);
      setActionError("");
      setActionMessage("");

      try {
        const formData = new FormData();
        formData.append("file", file);

        const result = await apiClient.postForm(
          `/system-assessments/${assessmentId}/nameplate-photo`,
          formData,
        );

        const attachResult = asObject(result.attachResult);
        if (attachResult.status && attachResult.status !== "EXECUTED") {
          throw new Error(
            attachResult.reason ||
              attachResult.error ||
              `Attachment link status: ${attachResult.status}`,
          );
        }

        setActionMessage("Nameplate photo captured and attached.");
        await assessmentQuery.refetch();
      } catch (error) {
        setActionError(getErrorText(error, "Unable to upload nameplate photo"));
      } finally {
        setUploading(false);
      }
    },
    [assessmentId, assessmentQuery],
  );

  const onFileInput = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      await uploadNameplate(file);
      event.target.value = "";
    },
    [uploadNameplate],
  );

  const openAttachment = useCallback(async (attachmentRefId) => {
    if (!attachmentRefId) {
      return;
    }
    setOpeningAttachmentId(attachmentRefId);
    setActionError("");

    try {
      const response = await apiClient.get(`/attachments/${attachmentRefId}/view`);
      if (response?.url) {
        window.open(response.url, "_blank", "noopener,noreferrer");
      } else {
        setActionError("Attachment URL is not available yet.");
      }
    } catch (error) {
      setActionError(getErrorText(error, "Unable to open attachment"));
    } finally {
      setOpeningAttachmentId("");
    }
  }, []);

  const persistSizingDecision = useCallback(
    async (choice) => {
      if (!assessmentId) {
        return;
      }

      const reasonRequired =
        choice === DECISION_CHOICES.USE_RECOMMENDED ||
        choice === DECISION_CHOICES.MANUAL_OVERRIDE;
      if (reasonRequired && !decisionReason.trim()) {
        setActionError("Reason is required for recommended size and manual override.");
        return;
      }

      const manualTonnageValue = parseNumberInput(manualTonnage);
      const manualBtuValue = parseNumberInput(manualBtu);

      if (
        choice === DECISION_CHOICES.MANUAL_OVERRIDE &&
        manualTonnageValue === null &&
        manualBtuValue === null
      ) {
        setActionError("Manual override requires tonnage or furnace BTU.");
        return;
      }

      let chosenTonnage = existingTonnage;
      let chosenBtu = existingBtu;

      if (choice === DECISION_CHOICES.USE_RECOMMENDED) {
        chosenTonnage = recommendedTonnageValue;
        chosenBtu = recommendedBtuValue;
      }
      if (choice === DECISION_CHOICES.MANUAL_OVERRIDE) {
        chosenTonnage = manualTonnageValue;
        chosenBtu = manualBtuValue;
      }

      setSavingDecision(true);
      setActionError("");
      setActionMessage("");

      try {
        const result = await apiClient.post(`/system-assessments/${assessmentId}/update`, {
          existingTonnage: chosenTonnage,
          existingFurnaceBtu: chosenBtu,
          verifiedBySupplyHouse:
            confirmedBySupplyHouse || Boolean(assessment?.verifiedBySupplyHouse),
          supplyHouseNotes:
            supplyHouseNotes.trim() || assessment?.supplyHouseNotes || null,
          metadata: {
            sizingDecision: {
              choice,
              reason: reasonRequired ? decisionReason.trim() : null,
              recommended: {
                tonnage: recommendedTonnageValue,
                btu: recommendedBtuValue,
              },
              existingBefore: {
                tonnage: existingTonnage,
                btu: existingBtu,
              },
              lowConfidence: isLowConfidence,
              confidence: latestConfidence,
              confirmedBySupplyHouse,
              hasNameplatePhoto,
            },
          },
        });

        if (result?.status !== "EXECUTED") {
          throw new Error(
            result?.reason || result?.error || result?.status || "Sizing decision blocked",
          );
        }

        setActionMessage("Sizing decision saved.");
        setShowMismatchModal(false);
        await assessmentQuery.refetch();
      } catch (error) {
        setActionError(getErrorText(error, "Unable to save sizing decision"));
      } finally {
        setSavingDecision(false);
      }
    },
    [
      assessment,
      assessmentId,
      assessmentQuery,
      confirmedBySupplyHouse,
      decisionReason,
      existingBtu,
      existingTonnage,
      hasNameplatePhoto,
      isLowConfidence,
      latestConfidence,
      manualBtu,
      manualTonnage,
      recommendedBtuValue,
      recommendedTonnageValue,
      supplyHouseNotes,
    ],
  );

  const attemptProceed = useCallback(async () => {
    setActionError("");
    setActionMessage("");

    const supplyHouseConditionMet =
      (confirmedBySupplyHouse && supplyHouseNotes.trim().length > 0) ||
      hasNameplatePhoto;

    if (isLowConfidence && !supplyHouseConditionMet) {
      setActionError(
        "Unable to confidently identify equipment. Verify model/serial or call supply house. Confirm by supply house + notes or attach a nameplate photo.",
      );
      return;
    }

    if (hasMismatch) {
      setDecisionChoice(DECISION_CHOICES.MATCH_EXISTING);
      setShowMismatchModal(true);
      return;
    }

    await persistSizingDecision(DECISION_CHOICES.MATCH_EXISTING);
  }, [
    confirmedBySupplyHouse,
    hasMismatch,
    hasNameplatePhoto,
    isLowConfidence,
    persistSizingDecision,
    supplyHouseNotes,
  ]);

  const setPricingField = useCallback((key, value) => {
    setPricingInputs((current) => ({
      ...current,
      [key]: value,
    }));
  }, []);

  const saveInstallPricingInputs = useCallback(async () => {
    if (!assessmentId || assessmentId === "new") {
      return;
    }

    const baseLaborCostCents = parseDollarsToCents(pricingInputs.baseLaborCost);
    const manualLaborAdjustmentCents = parseDollarsToCents(
      pricingInputs.manualLaborAdjustment,
    );
    const permitCostCents = parseDollarsToCents(pricingInputs.permitCost);

    if (
      baseLaborCostCents === null ||
      manualLaborAdjustmentCents === null ||
      permitCostCents === null
    ) {
      setActionError("Labor and permit values must be valid dollar amounts.");
      return;
    }

    if (
      manualLaborAdjustmentCents !== 0 &&
      !pricingInputs.manualLaborReason.trim()
    ) {
      setActionError(
        "Manual labor reason is required when manual labor adjustment is non-zero.",
      );
      return;
    }

    setPricingSectionBusy(true);
    setActionError("");
    setActionMessage("");

    try {
      const result = await apiClient.post(
        `/assessments/${assessmentId}/install-pricing-inputs`,
        {
          installType: pricingInputs.installType,
          accessType: pricingInputs.accessType,
          baseLaborCostCents,
          manualLaborAdjustmentCents,
          manualLaborReason:
            manualLaborAdjustmentCents === 0
              ? null
              : pricingInputs.manualLaborReason.trim(),
          permitCostCents,
        },
      );

      if (result?.status !== "EXECUTED") {
        throw new Error(
          result?.reason || result?.error || result?.status || "Pricing input update blocked",
        );
      }

      setActionMessage("Install pricing inputs saved.");
      await assessmentQuery.refetch();
    } catch (error) {
      setActionError(getErrorText(error, "Unable to save install pricing inputs"));
    } finally {
      setPricingSectionBusy(false);
    }
  }, [assessmentId, pricingInputs, assessmentQuery]);

  const setTierSelection = useCallback((tierKey, field, value) => {
    setTierSelections((current) => ({
      ...current,
      [tierKey]: {
        ...asObject(current[tierKey]),
        [field]: value,
      },
    }));
  }, []);

  const loadQuote = useCallback(async (quoteId) => {
    if (!quoteId) {
      return;
    }
    const response = await apiClient.get(`/quotes/${quoteId}`);
    const quote = response?.quote;
    if (!quote) {
      return;
    }
    setActiveQuoteId(quote.id);
    setActiveQuote({
      ...quote,
      options: sortOptions(quote.options),
    });
  }, []);

  const resolveLatestAssessmentQuoteId = useCallback(async () => {
    const refreshed = await apiClient.get(`/system-assessments/${assessmentId}`);
    const quotes = asArray(refreshed?.assessment?.quotes);
    if (quotes.length === 0) {
      return "";
    }
    const sorted = [...quotes].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return sorted[0]?.id || "";
  }, [assessmentId]);

  const generateInstallOptions = useCallback(async () => {
    if (!assessmentId || assessmentId === "new") {
      return;
    }
    if (!leadId.trim()) {
      setActionError("Lead ID is required to generate install quote options.");
      return;
    }

    const parsedTierSelections = {};
    for (const tierKey of TIER_KEYS) {
      const tier = asObject(tierSelections[tierKey]);
      const equipmentCostCents = parseDollarsToCents(tier.equipmentCost);
      const materialsCostCents = parseDollarsToCents(tier.materialsCost);

      if (equipmentCostCents === null || materialsCostCents === null) {
        setActionError(`Invalid equipment/material value for ${tierKey}.`);
        return;
      }

      parsedTierSelections[tierKey] = {
        equipment: [
          {
            sku: `${tierKey}-equipment`,
            label: tier.equipmentLabel || `${tierKey} equipment`,
            costCents: Math.max(0, equipmentCostCents),
          },
        ],
        materials: [
          {
            sku: `${tierKey}-materials`,
            label: tier.materialsLabel || `${tierKey} materials`,
            costCents: Math.max(0, materialsCostCents),
          },
        ],
      };
    }

    setQuoteBusy(true);
    setActionError("");
    setActionMessage("");

    try {
      const result = await apiClient.post("/quotes/install/generate", {
        leadId: leadId.trim(),
        assessmentId,
        tierSelections: parsedTierSelections,
      });

      if (result?.status === "EXECUTED") {
        const quoteId = asObject(result.output)?.quote?.id;
        if (quoteId) {
          await loadQuote(quoteId);
        }
        setActionMessage("Install options generated.");
        await assessmentQuery.refetch();
        return;
      }

      if (result?.status === "QUEUED_APPROVAL") {
        const latestQuoteId = await resolveLatestAssessmentQuoteId();
        if (latestQuoteId) {
          await loadQuote(latestQuoteId);
        }
        setActionMessage(
          "Install option generation queued for approval (guardrail requirement).",
        );
        await assessmentQuery.refetch();
        return;
      }

      if (result?.status === "BLOCKED") {
        throw new Error(
          result?.reason || "Install option generation blocked by guardrail policy.",
        );
      }

      throw new Error(result?.error || "Unable to generate install options");
    } catch (error) {
      setActionError(getErrorText(error, "Unable to generate install options"));
    } finally {
      setQuoteBusy(false);
    }
  }, [
    assessmentId,
    assessmentQuery,
    leadId,
    loadQuote,
    resolveLatestAssessmentQuoteId,
    tierSelections,
  ]);

  const setDiscountDraftField = useCallback((quoteOptionId, key, value) => {
    setDiscountDrafts((current) => ({
      ...current,
      [quoteOptionId]: {
        ...asObject(current[quoteOptionId]),
        [key]: value,
      },
    }));
  }, []);

  const applyDiscount = useCallback(
    async (option) => {
      if (!option?.id) {
        return;
      }

      const draft = asObject(discountDrafts[option.id]);
      const discountPct = parseNumberInput(draft.discountPct);
      const discountPctBps =
        discountPct === null ? 0 : Math.round(Math.max(0, discountPct) * 100);
      const discountCents = parseDollarsToCents(draft.discountDollars);
      const reason = typeof draft.reason === "string" ? draft.reason.trim() : "";

      if (discountCents === null) {
        setActionError("Discount dollars must be a valid number.");
        return;
      }
      if (discountPctBps > 10_000) {
        setActionError("Percent discount cannot exceed 100%.");
        return;
      }

      const hasDiscount = discountPctBps > 0 || discountCents > 0;
      if (hasDiscount && !reason) {
        setActionError("Discount reason is required.");
        return;
      }

      setDiscountBusyOptionId(option.id);
      setActionError("");
      setActionMessage("");

      try {
        const result = await apiClient.post(`/quotes/options/${option.id}/discount`, {
          discountPctBps,
          discountCents,
          reason: hasDiscount ? reason : null,
        });

        if (result?.status === "EXECUTED") {
          await loadQuote(option.quoteId);
          setActionMessage("Discount applied.");
          return;
        }

        if (result?.status === "QUEUED_APPROVAL") {
          await loadQuote(option.quoteId);
          setActionMessage("Discount queued for approval.");
          return;
        }

        if (result?.status === "BLOCKED") {
          await loadQuote(option.quoteId);
          setActionError(
            result?.reason || "Discount blocked. Owner override is required.",
          );
          return;
        }

        throw new Error(result?.error || "Discount update failed");
      } catch (error) {
        setActionError(getErrorText(error, "Unable to apply discount"));
      } finally {
        setDiscountBusyOptionId("");
      }
    },
    [discountDrafts, loadQuote],
  );

  const overrideBlockedOption = useCallback(
    async (option) => {
      if (!option?.id) {
        return;
      }

      const draft = asObject(discountDrafts[option.id]);
      const reason = typeof draft.reason === "string" ? draft.reason.trim() : "";
      if (!reason) {
        setActionError("Override reason is required.");
        return;
      }

      setOverrideBusyOptionId(option.id);
      setActionError("");
      setActionMessage("");

      try {
        const result = await apiClient.post(
          `/quotes/options/${option.id}/override-block`,
          { reason },
        );

        if (result?.status !== "EXECUTED") {
          throw new Error(
            result?.reason || result?.error || result?.status || "Override blocked",
          );
        }

        await loadQuote(option.quoteId);
        setActionMessage("Owner override recorded with audit trail.");
      } catch (error) {
        setActionError(getErrorText(error, "Unable to override blocked option"));
      } finally {
        setOverrideBusyOptionId("");
      }
    },
    [discountDrafts, loadQuote],
  );

  const card = {
    background: theme.colors.navyLight,
    border: `1px solid ${theme.colors.navyMid}`,
    borderRadius: 12,
    padding: 14,
  };

  if (!assessmentId || assessmentId === "new") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ ...card, padding: 20 }}>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>
            System Assessment
          </h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Create an assessment first, then capture nameplate photos from iPhone/Android camera.
          </p>
        </div>

        {actionError ? (
          <div
            style={{
              background: "#3D0011",
              border: "1px solid #6B1A2A",
              color: "#FFB8BE",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 13,
            }}
          >
            {actionError}
          </div>
        ) : null}

        {actionMessage ? (
          <div
            style={{
              background: "#0F3F33",
              border: "1px solid #0B6B55",
              color: "#C7FFF0",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 13,
            }}
          >
            {actionMessage}
          </div>
        ) : null}

        <div style={{ ...card, display: "grid", gap: 10, maxWidth: 540 }}>
          <button
            onClick={createAssessment}
            disabled={creating}
            style={{
              border: `1px solid ${theme.colors.teal}55`,
              background: `${theme.colors.teal}22`,
              color: theme.colors.teal,
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 13,
              cursor: creating ? "not-allowed" : "pointer",
            }}
          >
            {creating ? "Creating assessment..." : "Create System Assessment"}
          </button>
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
            After creation, use camera capture to upload the equipment nameplate photo.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div
        style={{
          ...card,
          padding: 20,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>
            Assessment {assessmentId}
          </h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Capture nameplate, verify sizing, then generate governed install quote options.
          </p>
        </div>
        <button
          onClick={() => navigate("/assessments/new")}
          style={{
            border: `1px solid ${theme.colors.navyMid}`,
            background: theme.colors.navyMid,
            color: theme.colors.gray200,
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          New assessment
        </button>
      </div>

      {actionError ? (
        <div
          style={{
            background: "#3D0011",
            border: "1px solid #6B1A2A",
            color: "#FFB8BE",
            borderRadius: 10,
            padding: "10px 12px",
            fontSize: 13,
          }}
        >
          {actionError}
        </div>
      ) : null}

      {actionMessage ? (
        <div
          style={{
            background: "#0F3F33",
            border: "1px solid #0B6B55",
            color: "#C7FFF0",
            borderRadius: 10,
            padding: "10px 12px",
            fontSize: 13,
          }}
        >
          {actionMessage}
        </div>
      ) : null}

      <div style={{ ...card, display: "grid", gap: 10 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Mobile Capture
        </div>
        <label
          style={{
            border: `1px dashed ${theme.colors.teal}77`,
            borderRadius: 10,
            padding: "12px",
            display: "grid",
            gap: 6,
            background: `${theme.colors.teal}11`,
            cursor: uploading ? "not-allowed" : "pointer",
          }}
        >
          <span style={{ color: theme.colors.teal, fontSize: 13, fontWeight: 600 }}>
            {uploading ? "Uploading..." : "Capture Nameplate Photo"}
          </span>
          <span style={{ color: theme.colors.gray400, fontSize: 11 }}>
            iPhone: this opens the rear camera when supported.
          </span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFileInput}
            disabled={uploading}
            style={{ color: theme.colors.gray300, fontSize: 12 }}
          />
        </label>
      </div>

      <div style={{ ...card, display: "grid", gap: 8 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Assessment Snapshot
        </div>
        {assessmentQuery.loading && !assessment ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
            Loading assessment...
          </div>
        ) : !assessment ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
            Assessment not found.
          </div>
        ) : (
          <>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Manufacturer: {assessment.existingManufacturer || "—"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Model: {assessment.existingModel || "—"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              System Type: {assessment.existingSystemType || "—"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Existing Tonnage: {assessment.existingTonnage ?? "—"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Existing Furnace BTU: {assessment.existingFurnaceBtu ?? "—"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Lookup Confidence: {latestConfidence !== null ? latestConfidence.toFixed(2) : "n/a"}
            </div>
            <div
              style={{
                color: isLowConfidence ? theme.colors.amber : theme.colors.gray400,
                fontSize: 11,
              }}
            >
              {isLowConfidence
                ? "Low confidence (<0.70). Supply-house confirmation or nameplate photo is required before proceeding."
                : "Confidence gate passed."}
            </div>
          </>
        )}
      </div>

      <div style={{ ...card, display: "grid", gap: 8 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Sizing Decision Gate
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 8,
          }}
        >
          <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
            Recommended Tonnage
            <input
              type="number"
              step="0.5"
              value={recommendedTonnage}
              onChange={(event) => setRecommendedTonnage(event.target.value)}
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.white,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
              }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
            Recommended Furnace BTU
            <input
              type="number"
              step="1000"
              value={recommendedBtu}
              onChange={(event) => setRecommendedBtu(event.target.value)}
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.white,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
              }}
            />
          </label>
        </div>

        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            color: theme.colors.gray300,
            fontSize: 12,
          }}
        >
          <input
            type="checkbox"
            checked={confirmedBySupplyHouse}
            onChange={(event) => setConfirmedBySupplyHouse(event.target.checked)}
            style={{ marginTop: 2 }}
          />
          Confirmed by supply house
        </label>
        <textarea
          value={supplyHouseNotes}
          onChange={(event) => setSupplyHouseNotes(event.target.value)}
          rows={2}
          placeholder="Supply house confirmation notes"
          style={{
            background: theme.colors.navyMid,
            color: theme.colors.white,
            border: `1px solid ${theme.colors.gray500}`,
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 12,
          }}
        />

        {hasMismatch ? (
          <div style={{ color: theme.colors.amber, fontSize: 11 }}>
            Recommended size differs from existing. Decision selection is required.
          </div>
        ) : null}

        <button
          onClick={attemptProceed}
          disabled={savingDecision}
          style={{
            border: `1px solid ${theme.colors.teal}55`,
            background: `${theme.colors.teal}22`,
            color: theme.colors.teal,
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12,
            cursor: savingDecision ? "not-allowed" : "pointer",
            width: "fit-content",
          }}
        >
          {savingDecision ? "Saving..." : "Save Sizing Decision"}
        </button>
      </div>

      <div style={{ ...card, display: "grid", gap: 10 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Install Pricing Inputs
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 8,
          }}
        >
          <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
            Install Type
            <select
              value={pricingInputs.installType}
              onChange={(event) => setPricingField("installType", event.target.value)}
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.white,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
              }}
            >
              {INSTALL_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
            Install Location
            <select
              value={pricingInputs.accessType}
              onChange={(event) => setPricingField("accessType", event.target.value)}
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.white,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
              }}
            >
              {ACCESS_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
            Base Labor ($)
            <input
              type="number"
              step="0.01"
              min="0"
              value={pricingInputs.baseLaborCost}
              onChange={(event) => setPricingField("baseLaborCost", event.target.value)}
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.white,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
              }}
            />
          </label>

          <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
            Manual Labor Adjustment ($)
            <input
              type="number"
              step="0.01"
              value={pricingInputs.manualLaborAdjustment}
              onChange={(event) =>
                setPricingField("manualLaborAdjustment", event.target.value)
              }
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.white,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
              }}
            />
          </label>

          <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
            Permit Cost ($)
            <input
              type="number"
              step="0.01"
              min="0"
              value={pricingInputs.permitCost}
              onChange={(event) => setPricingField("permitCost", event.target.value)}
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.white,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
              }}
            />
          </label>
        </div>

        <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
          Manual Labor Reason (required when adjustment is non-zero)
          <textarea
            rows={2}
            value={pricingInputs.manualLaborReason}
            onChange={(event) =>
              setPricingField("manualLaborReason", event.target.value)
            }
            style={{
              background: theme.colors.navyMid,
              color: theme.colors.white,
              border: `1px solid ${theme.colors.gray500}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
            }}
          />
        </label>

        {pricingInputs.accessType === "ATTIC" ||
        pricingInputs.accessType === "CONFINED_CRAWLSPACE" ? (
          <div style={{ color: theme.colors.amber, fontSize: 12 }}>
            Access Difficulty Adjustment applied (+$500).
          </div>
        ) : null}

        <button
          onClick={saveInstallPricingInputs}
          disabled={pricingSectionBusy}
          style={{
            border: `1px solid ${theme.colors.teal}55`,
            background: `${theme.colors.teal}22`,
            color: theme.colors.teal,
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12,
            cursor: pricingSectionBusy ? "not-allowed" : "pointer",
            width: "fit-content",
          }}
        >
          {pricingSectionBusy ? "Saving..." : "Save Pricing Inputs"}
        </button>
      </div>

      <div style={{ ...card, display: "grid", gap: 10 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Generate Install Quote Options
        </div>
        <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
          Final customer prices include required 5% sales cushion and approved discounts. Sales cushion is not shown as a customer line item.
        </div>

        <label style={{ display: "grid", gap: 4, color: theme.colors.gray400, fontSize: 11 }}>
          Lead ID
          <input
            value={leadId}
            onChange={(event) => setLeadId(event.target.value)}
            placeholder="Lead ID for this quote"
            style={{
              background: theme.colors.navyMid,
              color: theme.colors.white,
              border: `1px solid ${theme.colors.gray500}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
            }}
          />
        </label>

        <div style={{ display: "grid", gap: 10 }}>
          {TIER_KEYS.map((tierKey) => {
            const tier = asObject(tierSelections[tierKey]);
            return (
              <div
                key={tierKey}
                style={{
                  background: theme.colors.navyMid,
                  borderRadius: 10,
                  padding: 10,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ color: theme.colors.gray200, fontSize: 12, fontWeight: 700 }}>
                  {tierKey}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                    gap: 8,
                  }}
                >
                  <input
                    value={tier.equipmentLabel || ""}
                    onChange={(event) =>
                      setTierSelection(tierKey, "equipmentLabel", event.target.value)
                    }
                    placeholder="Equipment label"
                    style={{
                      background: theme.colors.navy,
                      color: theme.colors.white,
                      border: `1px solid ${theme.colors.gray500}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                    }}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={tier.equipmentCost || ""}
                    onChange={(event) =>
                      setTierSelection(tierKey, "equipmentCost", event.target.value)
                    }
                    placeholder="Equipment cost ($)"
                    style={{
                      background: theme.colors.navy,
                      color: theme.colors.white,
                      border: `1px solid ${theme.colors.gray500}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                    }}
                  />
                  <input
                    value={tier.materialsLabel || ""}
                    onChange={(event) =>
                      setTierSelection(tierKey, "materialsLabel", event.target.value)
                    }
                    placeholder="Materials label"
                    style={{
                      background: theme.colors.navy,
                      color: theme.colors.white,
                      border: `1px solid ${theme.colors.gray500}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                    }}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={tier.materialsCost || ""}
                    onChange={(event) =>
                      setTierSelection(tierKey, "materialsCost", event.target.value)
                    }
                    placeholder="Materials cost ($)"
                    style={{
                      background: theme.colors.navy,
                      color: theme.colors.white,
                      border: `1px solid ${theme.colors.gray500}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <button
          onClick={generateInstallOptions}
          disabled={quoteBusy}
          style={{
            border: `1px solid ${theme.colors.teal}55`,
            background: `${theme.colors.teal}22`,
            color: theme.colors.teal,
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12,
            cursor: quoteBusy ? "not-allowed" : "pointer",
            width: "fit-content",
          }}
        >
          {quoteBusy ? "Generating..." : "Generate Good / Better / Best"}
        </button>
      </div>

      <div style={{ ...card, display: "grid", gap: 10 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Quote Options
        </div>

        {!activeQuote || asArray(activeQuote.options).length === 0 ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
            No quote options yet. Save pricing inputs and generate options.
          </div>
        ) : (
          <>
            <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
              Quote {activeQuote.id} • Status: {activeQuote.status}
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {asArray(activeQuote.options).map((option) => {
                const draft = asObject(discountDrafts[option.id]);
                const badge = guardrailTone(option.guardrailStatus, theme);

                return (
                  <div
                    key={option.id}
                    style={{
                      background: theme.colors.navyMid,
                      borderRadius: 10,
                      padding: 12,
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 700 }}>
                          {option.label || option.optionKey}
                        </div>
                        <div style={{ color: theme.colors.gray300, fontSize: 11 }}>
                          Final Customer Price: {formatCurrency(option.finalSellPriceCents)}
                        </div>
                        {option.discountTotalCents > 0 ? (
                          <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                            Discount: -{formatCurrency(option.discountTotalCents)}
                          </div>
                        ) : null}
                      </div>

                      <div
                        style={{
                          ...badge,
                          borderRadius: 999,
                          padding: "4px 10px",
                          fontSize: 11,
                          fontWeight: 600,
                        }}
                      >
                        {guardrailLabel(option.guardrailStatus)}
                      </div>
                    </div>

                    {!isTech && canSeeCostDetails ? (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                          gap: 6,
                          color: theme.colors.gray400,
                          fontSize: 11,
                        }}
                      >
                        <div>Adjusted Cost: {formatCurrency(option.adjustedCostCents)}</div>
                        <div>Price Before Discount: {formatCurrency(option.priceBeforeDiscountCents)}</div>
                        <div>Profit Floor: {formatCurrency(option.profitFloorCents)}</div>
                        <div>Access Add-On: {formatCurrency(option.accessAddOnCents)}</div>
                      </div>
                    ) : null}

                    {canApplyDiscount && !isTech ? (
                      <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ color: theme.colors.gray300, fontSize: 12, fontWeight: 600 }}>
                          Discount Controls
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                            gap: 8,
                          }}
                        >
                          <label
                            style={{
                              display: "grid",
                              gap: 4,
                              color: theme.colors.gray400,
                              fontSize: 11,
                            }}
                          >
                            Percent Discount (%)
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={draft.discountPct ?? ""}
                              onChange={(event) =>
                                setDiscountDraftField(
                                  option.id,
                                  "discountPct",
                                  event.target.value,
                                )
                              }
                              style={{
                                background: theme.colors.navy,
                                color: theme.colors.white,
                                border: `1px solid ${theme.colors.gray500}`,
                                borderRadius: 8,
                                padding: "8px 10px",
                                fontSize: 12,
                              }}
                            />
                          </label>

                          <label
                            style={{
                              display: "grid",
                              gap: 4,
                              color: theme.colors.gray400,
                              fontSize: 11,
                            }}
                          >
                            Dollar Discount ($)
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={draft.discountDollars ?? ""}
                              onChange={(event) =>
                                setDiscountDraftField(
                                  option.id,
                                  "discountDollars",
                                  event.target.value,
                                )
                              }
                              style={{
                                background: theme.colors.navy,
                                color: theme.colors.white,
                                border: `1px solid ${theme.colors.gray500}`,
                                borderRadius: 8,
                                padding: "8px 10px",
                                fontSize: 12,
                              }}
                            />
                          </label>
                        </div>

                        <label
                          style={{
                            display: "grid",
                            gap: 4,
                            color: theme.colors.gray400,
                            fontSize: 11,
                          }}
                        >
                          Discount/Override Reason
                          <textarea
                            rows={2}
                            value={draft.reason ?? ""}
                            onChange={(event) =>
                              setDiscountDraftField(
                                option.id,
                                "reason",
                                event.target.value,
                              )
                            }
                            style={{
                              background: theme.colors.navy,
                              color: theme.colors.white,
                              border: `1px solid ${theme.colors.gray500}`,
                              borderRadius: 8,
                              padding: "8px 10px",
                              fontSize: 12,
                            }}
                          />
                        </label>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            onClick={() => applyDiscount(option)}
                            disabled={discountBusyOptionId === option.id}
                            style={{
                              border: `1px solid ${theme.colors.teal}55`,
                              background: `${theme.colors.teal}22`,
                              color: theme.colors.teal,
                              borderRadius: 8,
                              padding: "8px 10px",
                              fontSize: 12,
                              cursor:
                                discountBusyOptionId === option.id
                                  ? "not-allowed"
                                  : "pointer",
                            }}
                          >
                            {discountBusyOptionId === option.id
                              ? "Submitting..."
                              : "Apply Discount"}
                          </button>

                          {option.guardrailStatus === "BLOCK" && canOverrideBlock ? (
                            <button
                              onClick={() => overrideBlockedOption(option)}
                              disabled={overrideBusyOptionId === option.id}
                              style={{
                                border: "1px solid rgba(255, 176, 32, 0.45)",
                                background: "rgba(255, 176, 32, 0.18)",
                                color: "#FFD48A",
                                borderRadius: 8,
                                padding: "8px 10px",
                                fontSize: 12,
                                cursor:
                                  overrideBusyOptionId === option.id
                                    ? "not-allowed"
                                    : "pointer",
                              }}
                            >
                              {overrideBusyOptionId === option.id
                                ? "Overriding..."
                                : "Owner Override"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div style={{ ...card, display: "grid", gap: 8 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Nameplate Photos
        </div>
        {attachments.length === 0 ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
            No nameplate photos attached yet.
          </div>
        ) : (
          attachments.map((attachment) => (
            <div
              key={attachment.id}
              style={{
                background: theme.colors.navyMid,
                borderRadius: 8,
                padding: "8px 10px",
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div style={{ display: "grid", gap: 2 }}>
                <div style={{ color: theme.colors.gray200, fontSize: 12 }}>
                  {attachment.attachmentRef?.fileName || "Nameplate Photo"}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {formatDateTime(attachment.createdAt)}
                </div>
              </div>
              <button
                onClick={() => openAttachment(attachment.attachmentRefId)}
                disabled={openingAttachmentId === attachment.attachmentRefId}
                style={{
                  border: `1px solid ${theme.colors.teal}55`,
                  background: `${theme.colors.teal}22`,
                  color: theme.colors.teal,
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 11,
                  cursor:
                    openingAttachmentId === attachment.attachmentRefId
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {openingAttachmentId === attachment.attachmentRefId
                  ? "Opening..."
                  : "View"}
              </button>
            </div>
          ))
        )}
      </div>

      {showMismatchModal ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(1, 5, 13, 0.78)",
            display: "grid",
            placeItems: "center",
            padding: 16,
            zIndex: 2000,
          }}
        >
          <div
            style={{
              width: "min(560px, 100%)",
              background: theme.colors.navyLight,
              border: `1px solid ${theme.colors.navyMid}`,
              borderRadius: 12,
              padding: 14,
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ color: theme.colors.white, fontSize: 16, fontWeight: 700 }}>
              Sizing mismatch detected
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Existing and recommended sizes differ. Select one path before generating final options.
            </div>

            <label style={{ display: "flex", gap: 8, color: theme.colors.gray200, fontSize: 12 }}>
              <input
                type="radio"
                name="sizing-choice"
                checked={decisionChoice === DECISION_CHOICES.MATCH_EXISTING}
                onChange={() => setDecisionChoice(DECISION_CHOICES.MATCH_EXISTING)}
              />
              Match existing size (default)
            </label>
            <label style={{ display: "flex", gap: 8, color: theme.colors.gray200, fontSize: 12 }}>
              <input
                type="radio"
                name="sizing-choice"
                checked={decisionChoice === DECISION_CHOICES.USE_RECOMMENDED}
                onChange={() => setDecisionChoice(DECISION_CHOICES.USE_RECOMMENDED)}
              />
              Use recommended size (reason required)
            </label>
            <label style={{ display: "flex", gap: 8, color: theme.colors.gray200, fontSize: 12 }}>
              <input
                type="radio"
                name="sizing-choice"
                checked={decisionChoice === DECISION_CHOICES.MANUAL_OVERRIDE}
                onChange={() => setDecisionChoice(DECISION_CHOICES.MANUAL_OVERRIDE)}
              />
              Manual override (reason required)
            </label>

            {decisionChoice === DECISION_CHOICES.MANUAL_OVERRIDE ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 8,
                }}
              >
                <input
                  type="number"
                  step="0.5"
                  value={manualTonnage}
                  onChange={(event) => setManualTonnage(event.target.value)}
                  placeholder="Manual tonnage"
                  style={{
                    background: theme.colors.navyMid,
                    color: theme.colors.white,
                    border: `1px solid ${theme.colors.gray500}`,
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 12,
                  }}
                />
                <input
                  type="number"
                  step="1000"
                  value={manualBtu}
                  onChange={(event) => setManualBtu(event.target.value)}
                  placeholder="Manual furnace BTU"
                  style={{
                    background: theme.colors.navyMid,
                    color: theme.colors.white,
                    border: `1px solid ${theme.colors.gray500}`,
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 12,
                  }}
                />
              </div>
            ) : null}

            {decisionChoice === DECISION_CHOICES.USE_RECOMMENDED ||
            decisionChoice === DECISION_CHOICES.MANUAL_OVERRIDE ? (
              <textarea
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                rows={2}
                placeholder="Reason"
                style={{
                  background: theme.colors.navyMid,
                  color: theme.colors.white,
                  border: `1px solid ${theme.colors.gray500}`,
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                }}
              />
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setShowMismatchModal(false)}
                style={{
                  border: `1px solid ${theme.colors.navyMid}`,
                  background: theme.colors.navyMid,
                  color: theme.colors.gray200,
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => persistSizingDecision(decisionChoice)}
                disabled={savingDecision}
                style={{
                  border: `1px solid ${theme.colors.teal}55`,
                  background: `${theme.colors.teal}22`,
                  color: theme.colors.teal,
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                  cursor: savingDecision ? "not-allowed" : "pointer",
                }}
              >
                {savingDecision ? "Saving..." : "Save decision"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
