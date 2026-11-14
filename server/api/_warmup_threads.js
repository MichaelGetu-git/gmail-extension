// What the warmup accounts write to each other (api/warmup.js).
//
// Each thread is an everyday office conversation of five emails: one person
// opens it, four others answer in turn, and every answer picks up what the
// person before said. Each turn has more than one wording, picked at random,
// and each group in a round gets a different thread, so no two groups send
// the same text. Placeholders: {prev} is the first name of whoever wrote the
// message before, {name} the writer's own.
export const THREADS = [
  {
    id: 'sync-time',
    subject: 'Moving the weekly sync',
    turns: [
      [
        'Hi all,\n\nThe Monday slot for our weekly sync keeps clashing with other calls, so I would like to move it to Thursday at 10:00, starting next week. Same room, same length.\n\nDoes that work for everyone? If Thursday is bad for you, say so here and we will find another slot.',
        'Hello everyone,\n\nA few of you have mentioned that Monday morning is a bad time for the weekly sync. How about Thursday at 10:00 instead, from next week on?\n\nLet me know if that fits or if you would rather keep it where it is.',
      ],
      [
        'Hi {prev},\n\nThursday is better for me, Mondays are always full. The only thing is that I have a regular call that ends at 10:15, so I would be a little late every week. Could we make it 10:30?',
        'Thanks {prev}, I am glad to see it move. Thursday works, but 10:00 is tight on my side because of a standing call before it. Would 10:30 be possible?',
      ],
      [
        'I am fine with Thursday as well, and 10:30 like {prev} suggests is easier for me too. It also leaves time to read the notes beforehand.',
        'Thursday suits me. I would also go with 10:30 as {prev} says, since the earlier slot runs into my morning handover.',
      ],
      [
        'Thursday 10:30 works for me. {prev}, good point about the notes: I can send last week\'s action items around the day before so we do not spend the first ten minutes on them.',
        'No objection from me, 10:30 on Thursday is fine. If it helps I will circulate the open points on Wednesday afternoon, so we can start straight away.',
      ],
      [
        'Sounds settled then: Thursday at 10:30. Thanks {prev} for taking care of the action items. I will update my calendar now.',
        'Works for me too. Thursday 10:30 it is, and getting the open points a day early would be a real help. See you all then.',
      ],
    ],
  },
  {
    id: 'guide-draft',
    subject: 'Draft of the onboarding guide',
    turns: [
      [
        'Hi all,\n\nI have put a first draft of the onboarding guide for new colleagues in the shared folder. It covers the first week: accounts, tools, who to ask for what.\n\nCould you read through it and send me your comments by Friday? It is about six pages.',
        'Hello everyone,\n\nThe draft of the onboarding guide is ready and sits in the shared folder. It is meant to walk a new colleague through the first week.\n\nI would be grateful for comments by Friday, especially on anything that is missing.',
      ],
      [
        'Thanks {prev}, I read it this morning. It is clear and easy to follow. One thing I missed is a short list of contacts, so a new person knows who handles equipment, access and leave.',
        'Hi {prev},\n\nNice work, it reads well. My only suggestion is to add a page with the main contacts: who to ask about equipment, who about access, who about time off. That is what people ask most in the first days.',
      ],
      [
        'I agree with {prev} about the contact list. I also noticed that two of the screenshots in the tools section show the old layout, so they may confuse more than they help.',
        'Good draft. {prev} is right that a contact page would help. One more thing: the screenshots in the tools section are out of date, the menus look different now.',
      ],
      [
        'I can take new screenshots, {prev}. I have to set up a fresh laptop this week anyway, so I will capture each step as I go and drop the images in the same folder.',
        '{prev}, leave the screenshots to me. I am setting up a new machine this week, which is the perfect moment to capture every step. They will be in the folder by Thursday.',
      ],
      [
        'That covers everything I had noted. Thanks {prev} for the screenshots, and thanks for putting the guide together in the first place. No further comments from my side.',
        'Nothing to add from me, the contact list and the new screenshots were my two points as well. It will be a useful document. Thanks, all.',
      ],
    ],
  },
  {
    id: 'team-lunch',
    subject: 'Team lunch next Wednesday',
    turns: [
      [
        'Hi all,\n\nIt has been a while since we all sat down together, so I would like to organise a team lunch next Wednesday.\n\nWho is in, and does anyone have a place in mind? I will book once I have a rough number.',
        'Hello everyone,\n\nI am planning a team lunch for next Wednesday. Please tell me whether you can make it and whether you have a favourite place nearby.\n\nI will reserve a table as soon as I know how many we are.',
      ],
      [
        'Count me in, {prev}. How about the Italian place around the corner? It is close, the service is quick, and they can seat a large group.',
        'Good idea {prev}, I will be there. My suggestion would be the Italian restaurant on the corner, we were there last year and it worked well for a big table.',
      ],
      [
        'I am in as well. The Italian place is fine with me, {prev}, as long as they have a few vegetarian dishes. I do not remember what their menu looks like.',
        'Wednesday works for me. I like the idea, {prev}, I only want to check that there are vegetarian options on the menu before we decide.',
      ],
      [
        'They do, {prev}: several pasta dishes and a couple of salads without meat. I looked at the menu just now. If nobody objects, 12:30 would be a good time, before it gets busy.',
        'No worries {prev}, I checked their menu and there is a good choice of vegetarian dishes. I would propose 12:30, the place fills up after one.',
      ],
      [
        'Italian at 12:30 works for me, count me in. Thanks {prev} for checking the menu.',
        'I am happy with that: next Wednesday, 12:30, the Italian place. Looking forward to it.',
      ],
    ],
  },
  {
    id: 'days-off',
    subject: 'Days off next month',
    turns: [
      [
        'Hi all,\n\nTo plan cover for next month I need to know who is away and when. Please add your planned days off to the shared calendar by the end of this week.\n\nIf you have nothing planned, a short reply here is enough.',
        'Hello everyone,\n\nA quick reminder to enter next month\'s days off in the shared calendar by Friday, so we can sort out cover in good time.\n\nIf you are not planning any, just let me know here.',
      ],
      [
        'Done, {prev}. I am out on the 12th and 13th, both are in the calendar now. Nothing else planned on my side.',
        'Thanks for the reminder {prev}. I have added mine: two days in the second week. The rest of the month I am here.',
      ],
      [
        'I have added my days too. One question, {prev}: should half days go in the calendar as well? I have an appointment one afternoon and was not sure.',
        'Mine are in. A question for {prev} or anyone who knows: do we enter half days too? I will be away for one afternoon.',
      ],
      [
        'Yes {prev}, half days as well. I entered mine as a normal entry and wrote "afternoon only" in the title, which shows up clearly in the month view.',
        '{prev}, I would put it in. I did the same for a morning appointment and simply added "morning" to the title, so it is obvious at a glance.',
      ],
      [
        'Good to know about the half days, thanks {prev}. Mine are all entered now, one full day at the end of the month.',
        'Thanks {prev}, that answers my question too. I have just added my days, so the calendar should be complete from my side.',
      ],
    ],
  },
  {
    id: 'monthly-summary',
    subject: 'Your points for the monthly summary',
    turns: [
      [
        'Hi all,\n\nI am putting together the monthly summary again. Please send me two or three points on what you worked on this month, by Wednesday.\n\nShort is fine, I will bring it into one format.',
        'Hello everyone,\n\nIt is time for the monthly summary. Could each of you give me a few lines on your work this month by Wednesday?\n\nBullet points are enough, I will do the editing.',
      ],
      [
        'Will do, {prev}, you will have mine by Tuesday. Should we write them straight into last month\'s document, or do you want them by email?',
        'No problem {prev}. One question before I start: do you want the points by email, or should we add them to the shared document like last time?',
      ],
      [
        'I think the shared document is easier, {prev}. I have just added a section for this month at the top, with a heading for each of us, so everything stays in one place.',
        '{prev}, I would use the shared document again. I created this month\'s section a moment ago with one heading per person, feel free to write under yours.',
      ],
      [
        'Thanks {prev}, that makes it simple. My three points are in, under my name. I kept them short.',
        'Good idea {prev}. I have filled in my part: three points, the last one still needs a number that I will get tomorrow.',
      ],
      [
        'The document works well for this, thanks {prev} for setting it up. Mine will be in by tomorrow morning at the latest.',
        'I have added mine as well, right below the others. Thanks for collecting these every month.',
      ],
    ],
  },
  {
    id: 'system-update',
    subject: 'Laptop update before Monday',
    turns: [
      [
        'Hi all,\n\nA new system update is available for our laptops, and it should be installed on every machine before Monday.\n\nPlease run it when you have a quiet half hour and reply here once it is done, so I can tick you off the list.',
        'Hello everyone,\n\nPlease install the latest system update on your laptop by Monday. It takes a while, so pick a moment when you do not need the machine.\n\nA short reply here when you are done would help me keep track.',
      ],
      [
        'Done on my laptop, {prev}. It took about twenty minutes from start to finish and everything works as before.',
        'Mine is updated, {prev}. Around twenty minutes in total, no problems afterwards.',
      ],
      [
        'Good to hear, {prev}. Does it need a restart? I have a lot of windows open and would rather do it at the end of the day if so.',
        'Thanks {prev}. One question before I start: does the laptop restart during the update? Then I will wait until I have saved everything.',
      ],
      [
        'Yes {prev}, one restart near the end. Save your work first. After that it opened my windows again on its own, but I would not rely on that.',
        '{prev}, it restarts once. I closed everything beforehand to be safe, and it was back up after a few minutes.',
      ],
      [
        'Thanks {prev}, I did it over lunch with everything saved. Done here as well, no issues.',
        'Updated on my side too. One restart as {prev} said, and it was finished in under half an hour.',
      ],
    ],
  },
];

const SIGN_OFFS = ['Best,', 'Thanks,', 'Best regards,', 'Regards,', 'Cheers,'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export const threadById = (id) => THREADS.find((t) => t.id === id) || THREADS[0];

// The text of one turn (1-based) of a thread, signed by its writer.
export function turnText(thread, turn, { name, prev }) {
  const body = pick(thread.turns[turn - 1]).replaceAll('{prev}', prev || 'all').replaceAll('{name}', name);
  return `${body}\n\n${pick(SIGN_OFFS)}\n${name}`;
}
