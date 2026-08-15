/*==============================================================================
  SAMPLE APPLICANTS.

  ⚠️ This is fixture data, not a service. JP.App.Api — which owns jobs and
  applications — is Phase 2; there is no /api/applicants to call yet.

  It exists so the dense list screen can be designed and reviewed against
  realistic content at realistic volume, which is the only way to find out
  whether a visual direction survives 50 rows. Designing that screen against
  three rows of "Lorem Ipsum" is how directions get approved and then collapse.

  When the endpoint lands, this file is deleted and the component takes a
  PagedResult<ApplicantListItem> instead. Nothing else about the screen changes.
==============================================================================*/

/** Teacher grades used across Indian schools. */
export type TeacherGrade = 'PRT' | 'TGT' | 'PGT';

export interface Applicant {
  applicationId: string;
  name: string;
  /** The job they applied to. */
  role: string;
  grade: TeacherGrade;
  subject: string;
  /** Years of teaching experience. */
  experience: number;
  /** ISO date. */
  appliedOn: string;
  /** 1–7 against APPLICATION_STAGES. */
  stage: number;
  /** True when the application stopped — rejected or withdrawn. */
  closed?: boolean;
  /** Working days this has been sitting with the school. */
  waitingDays: number;
}

const NAMES = [
  'Aarti Deshpande', 'Rajesh Kulkarni', 'Sneha Iyer', 'Mohammed Arif', 'Kavya Reddy',
  'Anand Krishnan', 'Priya Nair', 'Vikram Chauhan', 'Deepa Menon', 'Suresh Patil',
  'Fatima Sheikh', 'Rahul Bhatt', 'Meera Joshi', 'Karan Malhotra', 'Anjali Verma',
  'Sanjay Rao', 'Nisha Pillai', 'Imran Qureshi', 'Divya Sundaram', 'Arjun Sinha',
  'Lakshmi Narayan', 'Gaurav Saxena', 'Pooja Agarwal', 'Naveen Kumar', 'Ritu Chandra',
  'Farhan Ansari', 'Shalini Gupta', 'Ajay Thakur', 'Bhavana Shetty', 'Rohit Mehta',
  'Swati Bansal', 'Kiran Desai', 'Manish Tiwari', 'Preeti Malhotra', 'Sameer Khan',
  'Vidya Balan', 'Nitin Chopra', 'Rekha Prasad', 'Aditya Ghosh', 'Neha Kapoor',
  'Ravi Shankar', 'Sunita Yadav', 'Harish Bhatia', 'Ananya Sen', 'Vivek Raman',
  'Jyoti Mishra', 'Prakash Jain', 'Tanvi Shah', 'Mahesh Pawar', 'Ishita Roy',
];

const ROLES = [
  'Mathematics Teacher — Class 9-10',
  'English Teacher — Class 6-8',
  'Physics Teacher — Class 11-12',
  'Primary Class Teacher',
  'Chemistry Teacher — Class 11-12',
  'Hindi Teacher — Class 6-10',
  'Computer Science Teacher',
  'Biology Teacher — Class 11-12',
];

const SUBJECTS = [
  'Mathematics', 'English', 'Physics', 'General', 'Chemistry',
  'Hindi', 'Computer Science', 'Biology',
];

const GRADES: TeacherGrade[] = ['PRT', 'TGT', 'PGT'];

/**
 * Fifty rows, generated deterministically so the screen looks the same on
 * every reload — a list that reshuffles is impossible to review.
 */
export const SAMPLE_APPLICANTS: Applicant[] = NAMES.map((name, index) => {
  const roleIndex = index % ROLES.length;

  // A believable funnel rather than an even spread: most applications sit at
  // Applied or Viewed, a handful reach Offer, one or two get Hired. That shape
  // is the whole reason the roll is worth drawing.
  const stageWeights = [1, 1, 2, 1, 2, 3, 1, 2, 1, 4, 2, 1, 3, 1, 2, 5, 1, 2, 3, 1];
  const stage = stageWeights[index % stageWeights.length] + (index % 7 === 0 ? 2 : 0);

  return {
    applicationId: `APP-${(2401 + index).toString()}`,
    name,
    role: ROLES[roleIndex],
    grade: GRADES[index % GRADES.length],
    subject: SUBJECTS[roleIndex],
    experience: 1 + ((index * 3) % 18),
    appliedOn: new Date(Date.UTC(2026, 6, 2 + (index % 28))).toISOString(),
    stage: Math.min(stage, 7),
    closed: index % 13 === 5,
    waitingDays: (index * 2) % 11,
  };
});
