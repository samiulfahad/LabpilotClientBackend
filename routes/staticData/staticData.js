/**
 * departmentRoutes.js
 * Serves the canonical department, designation, and staff-permission lists.
 * No per-hospital DB storage.
 */

export const ALLOWED_MED_DEPARTMENTS = [
  { value: "anesthesiology", label: "Anesthesiology" },
  { value: "cardiology", label: "Cardiology" },
  { value: "dentistry", label: "Dentistry" },
  { value: "dermatology", label: "Dermatology" },
  { value: "endocrinology", label: "Endocrinology" },
  { value: "ent", label: "ENT (Ear, Nose & Throat)" },
  { value: "gastroenterology", label: "Gastroenterology" },
  { value: "general", label: "General Medicine" },
  { value: "surgery", label: "General Surgery" },
  { value: "gynecology", label: "Gynecology & Obstetrics" },
  { value: "hematology", label: "Hematology" },
  { value: "nephrology", label: "Nephrology" },
  { value: "neurology", label: "Neurology" },
  { value: "nutrition", label: "Nutrition & Dietetics" },
  { value: "oncology", label: "Oncology" },
  { value: "ophthalmology", label: "Ophthalmology" },
  { value: "orthopedics", label: "Orthopedics" },
  { value: "pediatrics", label: "Pediatrics" },
  { value: "physiotherapy", label: "Physiotherapy & Rehab" },
  { value: "psychiatry", label: "Psychiatry" },
  { value: "pulmonology", label: "Pulmonology" },
  { value: "radiology", label: "Radiology & Imaging" },
  { value: "rheumatology", label: "Rheumatology" },
  { value: "urology", label: "Urology" },
  { value: "other", label: "Other" },
];

export const ALLOWED_DESIGNATIONS = [
  { value: "professor", label: "Professor" },
  { value: "associate_professor", label: "Associate Professor" },
  { value: "assistant_professor", label: "Assistant Professor" },
  { value: "consultant", label: "Consultant" },
  { value: "senior_consultant", label: "Senior Consultant" },
  { value: "resident", label: "Resident" },
  { value: "medical_officer", label: "Medical Officer" },
  { value: "house_officer", label: "House Officer" },
  { value: "intern", label: "Intern" },
  { value: "general_practitioner", label: "General Practitioner" },
  { value: "specialist", label: "Specialist" },
  { value: "other", label: "Other" },
];

export const ALLOWED_PERMISSIONS = [
  { key: "createInvoice", label: "ইনভয়েস তৈরি", module: "invoice", for: "both" },
  { key: "deleteInvoice", label: "ইনভয়েস ডিলিট", module: "invoice", for: "both" },
  { key: "invoiceList", label: "ইনভয়েস লিস্ট", module: "invoice", for: "both" },
  { key: "addExpense", label: "নতুন খরচ/ব্যয় তৈরি", module: "expense", for: "both" },
  { key: "deleteExpense", label: "খরচ/ব্যয় ডিলিট", module: "expense", for: "both" },
  { key: "expenseList", label: "খরচ/ব্যয়ের তালিকা", module: "expense", for: "both" },
  { key: "cashmemo", label: "ক্যাশমেমু", module: "dailyReport", for: "both" },
  { key: "salesReport", label: "সেলস রিপোর্ট", module: "dailyReport", for: "both" },
  { key: "expenseReport", label: "এক্সপেন্স (খরচ/ব্যয়) রিপোর্ট", module: "dailyReport", for: "both" },
  { key: "commissionReport", label: "কমিশন রিপোর্ট", module: "dailyReport", for: "both" },
  { key: "discountReport", label: "ডিস্কাউন্ট রিপোর্ট", module: "dailyReport", for: "both" },
  { key: "collectionReport", label: "কালেকশন রিপোর্র", module: "dailyReport", for: "both" },
  { key: "testReportDownload", label: "টেস্ট রিপোর্ট প্রিন্ট/ডাউনলোড", module: "testReport", for: "both" },
  { key: "testReportUpload", label: "টেস্ট রিপোর্ট আপলোড", module: "testReport", for: "both" },
  { key: "manageProducts", label: "পণ্য, ঔষধ, সেবা ম্যানেজমেন্ট", module: "setup", for: "both" },
  { key: "manageReferrers", label: "রেফারার ম্যানেজমেন্ট", module: "setup", for: "both" },
  { key: "manageDoctors", label: "ডাক্তার ম্যানেজমেন্ট", module: "setup", for: "both" },
  { key: "manageTests", label: "টেস্টের মূল্য ও কমিশন", module: "setup", for: "both" },
  { key: "manageTestConfig", label: "টেস্ট ফরম্যাট", module: "setup", for: "both" },
  { key: "manageStaffs", label: "স্টাফ অ্যাকাউন্ট ম্যানেজমেন্ট", module: "setup", for: "both" },
  { key: "manageAdmissionSpace", label: "রোগী ভর্তির ওয়ার্ড, আইসিইউ ইত্যাদি", module: "setup", for: "hospitalOnly" },
  { key: "manageBilling", label: "মাসিক বিলিং", module: "billing", for: "both" },
  { key: "admitPatient", label: "নতুন রোগী ভর্তি", module: "indoorPatient", for: "hospitalOnly" },
  { key: "patientList", label: "ভর্তি রোগীর তালিকা", module: "indoorPatient", for: "hospitalOnly" },
  { key: "addExpenseToPatient", label: "ভর্তি রোগীর টেস্ট/ঔষধ/খরচ যোগ", module: "indoorPatient", for: "hospitalOnly" },
  {
    key: "discount",
    label: "ডিস্কাউন্ট প্রদান এবং বিলিং তথ্য",
    module: "indoorPatient",
    for: "hospitalOnly",
  },
  { key: "deletePatient", label: "ভর্তি রোগীর তথ্য ডিলিট", module: "indoorPatient", for: "hospitalOnly" },
  { key: "editPatient", label: "ভর্তি রোগীর তথ্য পরিবর্তন", module: "indoorPatient", for: "hospitalOnly" },
  { key: "patientBilling", label: "বিলিং তথ্য", module: "indoorPatient", for: "hospitalOnly" },
  { key: "releasePatient", label: "ভর্তি রোগী রিলিজ দেওয়া", module: "indoorPatient", for: "hospitalOnly" },
];

export const ALLOWED_DEPARTMENTS = new Set(ALLOWED_MED_DEPARTMENTS.map((d) => d.value));
export const ALLOWED_DESIG_VALUES = new Set(ALLOWED_DESIGNATIONS.map((d) => d.value));
export const ALLOWED_PERM_KEYS = new Set(ALLOWED_PERMISSIONS.map((p) => p.key));

async function staticDataRoutes(fastify) {
  // ── GET /departments ──────────────────────────────────────────────────────
  fastify.get(
    "/departments",
    { schema: { tags: ["Departments"], summary: "Get all available departments" } },
    async (_req, reply) => reply.send({ departments: ALLOWED_MED_DEPARTMENTS }),
  );

  // ── GET /designations ─────────────────────────────────────────────────────
  fastify.get(
    "/designations",
    { schema: { tags: ["Departments"], summary: "Get all available designations" } },
    async (_req, reply) => reply.send({ designations: ALLOWED_DESIGNATIONS }),
  );

  // ── GET /staff-permissions ────────────────────────────────────────────────
  fastify.get(
    "/staff-permissions",
    { schema: { tags: ["Staff"], summary: "Get all available staff permissions" } },
    async (_req, reply) => reply.send({ permissions: ALLOWED_PERMISSIONS }),
  );
}

export default staticDataRoutes;
