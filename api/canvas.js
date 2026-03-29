export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const CANVAS_TOKEN = process.env.CANVAS_TOKEN;
  const BASE_URL = 'https://umich.instructure.com/api/v1';

  if (!CANVAS_TOKEN) {
    return res.status(500).json({ error: 'Canvas token not configured' });
  }

  const headers = {
    'Authorization': `Bearer ${CANVAS_TOKEN}`,
    'Content-Type': 'application/json',
  };

  try {
    // Fetch active courses with grade data
    const coursesRes = await fetch(
      `${BASE_URL}/courses?enrollment_state=active&include[]=total_scores&include[]=current_grading_period_scores&per_page=20`,
      { headers }
    );
    const courses = await coursesRes.json();

    if (!Array.isArray(courses)) {
      return res.status(500).json({ error: 'Failed to fetch courses', detail: courses });
    }

    // Fetch upcoming assignments across all courses
    const assignmentPromises = courses.map(course =>
      fetch(
        `${BASE_URL}/courses/${course.id}/assignments?order_by=due_at&bucket=upcoming&per_page=10`,
        { headers }
      )
        .then(r => r.json())
        .then(assignments =>
          Array.isArray(assignments)
            ? assignments.map(a => ({
                id: a.id,
                name: a.name,
                due_at: a.due_at,
                points_possible: a.points_possible,
                course_name: course.name,
                course_id: course.id,
                html_url: a.html_url,
              }))
            : []
        )
        .catch(() => [])
    );

    const assignmentArrays = await Promise.all(assignmentPromises);
    const assignments = assignmentArrays
      .flat()
      .filter(a => a.due_at)
      .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));

    // Fetch announcements
    const contextCodes = courses.map(c => `course_${c.id}`);
    const announcementsUrl = `${BASE_URL}/announcements?${contextCodes.map(c => `context_codes[]=${c}`).join('&')}&per_page=10`;
    const announcementsRes = await fetch(announcementsUrl, { headers });
    const announcements = await announcementsRes.json();

    // Build grades summary
    const grades = courses.map(course => ({
      id: course.id,
      name: course.name,
      score: course.enrollments?.[0]?.computed_current_score ?? null,
      grade: course.enrollments?.[0]?.computed_current_grade ?? null,
    }));

    res.json({
      courses: courses.map(c => ({ id: c.id, name: c.name })),
      assignments,
      announcements: Array.isArray(announcements) ? announcements.slice(0, 10) : [],
      grades,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
